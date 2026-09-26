import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, type Config } from './config.ts';
import { MavenRegistryProxy } from './registries/maven.ts';
import { IvyRegistryProxy } from './registries/ivy.ts';
import {
  resolveArtifactoryEndpoint,
  type ArtifactoryEndpoint,
} from './registries/artifactory.ts';
import { GradlePluginsRegistryProxy } from './registries/gradle-plugins.ts';
import { NpmRegistryProxy } from './registries/npm.ts';
import { PypiRegistryProxy } from './registries/pypi.ts';
import { RubygemsRegistryProxy } from './registries/rubygems.ts';
import { GoRegistryProxy } from './registries/go.ts';
import { ComposerRegistryProxy } from './registries/composer.ts';
import { buildMaliciousDB } from './scripts/build-malicious-db.ts';

/** A resolved `index=artifactory`: where its API lives and what answered. */
interface IvyIndex {
  endpoint: ArtifactoryEndpoint;
  version: string;
}

/**
 * Resolve and verify the storage API endpoint for every --ivy-repo that asked
 * for one.
 *
 * Done at startup, and fatal on failure: a listing is what a resolver picks a
 * dynamic revision from, so a repository configured to filter it either can or
 * the proxy should not pretend to.
 */
async function resolveIvyIndexes(
  config: Config,
): Promise<Map<string, IvyIndex>> {
  const indexes = new Map<string, IvyIndex>();
  for (const repo of config.ivyRepos ?? []) {
    if (repo.index !== 'artifactory') continue;
    const resolved = await resolveArtifactoryEndpoint(repo.upstream);
    if ('error' in resolved) {
      console.error(
        `Error: --ivy-repo '${repo.name}' has index=artifactory but its ` +
          `storage API is unusable: ${resolved.error}`,
      );
      process.exit(1);
    }
    indexes.set(repo.name, resolved);
  }
  return indexes;
}

export function createServer(
  config: Config,
  ivyIndexes: Map<string, IvyIndex> = new Map(),
): express.Express {
  const app = express();

  const delayMs = config.delayDays * 24 * 60 * 60 * 1000;

  const maliciousDbPath = config.maliciousDbPath;
  const allowlistDbPath = config.allowlistDbPath;
  const upstreamAccess = config.upstreamAccess;
  const baseUrl = config.baseUrl;
  const registries = [
    new NpmRegistryProxy({
      upstream: config.upstreams.npm,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    new PypiRegistryProxy({
      upstream: config.upstreams.pypi,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    new RubygemsRegistryProxy({
      upstream: config.upstreams.rubygems,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    new GoRegistryProxy({
      upstream: config.upstreams.go,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    new ComposerRegistryProxy({
      upstream: config.upstreams.composer,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    new MavenRegistryProxy({
      upstream: config.upstreams.maven,
      timestampSource: config.mavenTimestampSource ?? 'deps-dev',
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    new GradlePluginsRegistryProxy({
      upstream: config.upstreams.gradlePlugins,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
    }),
    // Extra Maven repositories declared with --maven-repo, each mounted at its
    // own top-level path. deps.dev only indexes Central, so these read publish
    // timestamps from the upstream's Last-Modified headers.
    ...(config.mavenRepos ?? []).map(
      (repo) =>
        new MavenRegistryProxy({
          name: repo.name,
          upstream: repo.upstream,
          timestampSource: 'last-modified',
          delayMs,
          maliciousDbPath,
          allowlistDbPath,
          upstreamAccess,
          baseUrl,
        }),
    ),
    // Ivy-layout repositories declared with --ivy-repo. sbt's default resolver
    // set includes three of them, so proxying sbt means handling Ivy.
    ...(config.ivyRepos ?? []).map(
      (repo) =>
        new IvyRegistryProxy({
          name: repo.name,
          upstream: repo.upstream,
          endpoint: ivyIndexes.get(repo.name)?.endpoint,
          delayMs,
          maliciousDbPath,
          allowlistDbPath,
          upstreamAccess,
          baseUrl,
        }),
    ),
  ];

  for (const registry of registries) {
    app.use(`/${registry.name}`, (req, res) => {
      const start = Date.now();
      console.log(`[${registry.name}] ${req.method} ${req.path}`);

      res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(
          `[${registry.name}] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`,
        );
      });

      registry.handleRequest(req, res).catch((err) => {
        console.error(
          `[${registry.name}] ${req.method} ${req.path} error:`,
          err,
        );
        if (!res.headersSent) {
          res
            .status(500)
            .json({ error: 'Internal Server Error', message: String(err) });
        }
      });
    });
  }

  return app;
}

export async function startServer(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const config = loadConfig(argv);

  if (config.maliciousDbPath) {
    if (!existsSync(config.maliciousDbPath)) {
      console.error(
        `Error: malicious DB not found at ${config.maliciousDbPath}`,
      );
      process.exit(1);
    }
  } else {
    config.maliciousDbPath = join(tmpdir(), 'tengen-malicious-db.json');
    console.log(
      `No malicious DB path specified, building into ${config.maliciousDbPath}…`,
    );
    await buildMaliciousDB(config.maliciousDbPath);
    console.log(`Malicious DB built successfully at ${config.maliciousDbPath}`);
  }

  const ivyIndexes = await resolveIvyIndexes(config);
  const app = createServer(config, ivyIndexes);
  app.listen(config.port, config.host, () => {
    console.log(`tengen registry proxy started`);
    for (const [name, url] of Object.entries(config.upstreams)) {
      console.log(`  ${name.padEnd(10)}  ${url}`);
    }
    for (const repo of config.mavenRepos ?? []) {
      console.log(
        `  ${repo.name.padEnd(10)}  ${repo.upstream} (maven, last-modified)`,
      );
    }
    for (const repo of config.ivyRepos ?? []) {
      const index = ivyIndexes.get(repo.name);
      console.log(`  ${repo.name.padEnd(10)}  ${repo.upstream} (ivy)`);
      if (index) {
        console.log(
          `  ${''.padEnd(10)}  index=artifactory via ` +
            `${index.endpoint.apiBase} repo=${index.endpoint.repo} ` +
            `(Artifactory ${index.version})`,
        );
      }
    }
    console.log(`  delay:      ${config.delayDays} day(s)`);
    console.log(`  upstream-access: ${config.upstreamAccess}`);
    if (config.baseUrl) {
      console.log(`  base-url:   ${config.baseUrl}`);
    }
    console.log(`  malicious:  ${config.maliciousDbPath}`);
    if (config.allowlistDbPath) {
      console.log(`  allowlist:  ${config.allowlistDbPath}`);
    }
    console.log(`  listening:  http://${config.host}:${config.port}`);
  });
}
