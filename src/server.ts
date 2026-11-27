import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, type Config } from './config.ts';
import { MavenRegistryProxy } from './registries/maven.ts';
import { GradlePluginsRegistryProxy } from './registries/gradle-plugins.ts';
import { NpmRegistryProxy } from './registries/npm.ts';
import { PypiRegistryProxy } from './registries/pypi.ts';
import { RubygemsRegistryProxy } from './registries/rubygems.ts';
import { GoRegistryProxy } from './registries/go.ts';
import { ComposerRegistryProxy } from './registries/composer.ts';
import { buildMaliciousDB } from './scripts/build-malicious-db.ts';

export function createServer(config: Config): express.Express {
  const app = express();

  const delayMs = config.delayDays * 24 * 60 * 60 * 1000;

  const maliciousDbPath = config.maliciousDbPath;
  const allowlistDbPath = config.allowlistDbPath;
  const upstreamAccess = config.upstreamAccess;
  const baseUrl = config.baseUrl;
  const lastModifiedFallback = config.mavenLastModifiedFallback;
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
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
      lastModifiedFallback,
    }),
    new GradlePluginsRegistryProxy({
      upstream: config.upstreams.gradlePlugins,
      delayMs,
      maliciousDbPath,
      allowlistDbPath,
      upstreamAccess,
      baseUrl,
      lastModifiedFallback,
    }),
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

  const app = createServer(config);
  app.listen(config.port, config.host, () => {
    console.log(`tengen registry proxy started`);
    for (const [name, url] of Object.entries(config.upstreams)) {
      console.log(`  ${name.padEnd(10)}  ${url}`);
    }
    console.log(`  delay:      ${config.delayDays} day(s)`);
    console.log(`  upstream-access: ${config.upstreamAccess}`);
    console.log(
      `  maven-last-modified-fallback: ${config.mavenLastModifiedFallback ? 'on' : 'off'}`,
    );
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
