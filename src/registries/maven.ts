import type { Request, Response } from 'express';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { RegistryProxy, type VersionMetadata } from './base.ts';
import { LastModifiedProbe, parseHttpDate } from './last-modified.ts';

interface DepsDevVersionEntry {
  versionKey: { system: string; name: string; version: string };
  publishedAt: string;
}

interface DepsDevPackageResponse {
  versions: DepsDevVersionEntry[];
}

interface DepsDevVersionResponse {
  versionKey: { system: string; name: string; version: string };
  publishedAt: string;
}

/** How many `Last-Modified` probes run at once. */
const PROBE_CONCURRENCY = 8;

/**
 * How long a probed timestamp is reused.
 *
 * Without a cache every metadata request re-probes every version deps.dev has no
 * date for. The window is short because a repository can rewrite an artifact's
 * mtime on re-sync, and a stale value would keep serving a version whose
 * timestamp has since moved forward into the cooldown window.
 */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** How many probed timestamps are kept before the oldest are dropped. */
const PROBE_CACHE_MAX = 10_000;

/** POM probes keyed by URL and shared across registry instances. */
const pomProbe = new LastModifiedProbe(PROBE_TTL_MS, PROBE_CACHE_MAX);

/** The `_<scala>_<sbt>` suffix of an sbt plugin's artifactId, such as `_2.12_1.0` or `_2.10_0.13`. */
const SBT_PLUGIN_SUFFIX = /_\d+(?:\.\d+)*_\d+(?:\.\d+)*$/;

/** @internal Reset the probe cache. Used by tests; not part of the public API. */
export function __resetProbeCacheForTesting() {
  pomProbe.clear();
}

export class MavenRegistryProxy extends RegistryProxy {
  readonly name: string = 'maven';

  /**
   * Routes requests:
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml        → filtered XML metadata
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml.sha1  → SHA1 of filtered XML
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml.md5   → MD5 of filtered XML
   *   /{groupId/as/path}/{artifactId}/{version}/{file}          → download check (403 if version blocked)
   *   everything else                                           → passthrough
   */
  public setRouting() {
    this.addMetadataRoute<string>({
      condition: (req) => isMavenMetadataPath(req.path),
      requestUpstream: (req) => this.fetchUpstreamXml(req),
      getVersions: (metadata, req) => this.fetchVersions(metadata, req),
      filterMetadata: (metadata, allowedVersions) =>
        this.filterXml(metadata, allowedVersions),
      respond: (res, filteredMetadata, req) =>
        this.respondWithMetadata(res, filteredMetadata, req),
    });

    this.addDownloadRoute({
      condition: (req) => isMavenDownloadPath(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });
  }

  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const parsed = parseMavenDownloadPath(req.path);
    if (!parsed) return null;
    const { groupId, artifactId, version } = parsed;
    const packageName = `${groupId}:${artifactId}`;
    const res = await axios.get<DepsDevVersionResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}/versions/${encodeURIComponent(version)}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    const published = parseDepsDevDate(res.data?.publishedAt);
    if (res.status === 200 && published) {
      return {
        packageName,
        version: res.data.versionKey.version,
        published,
      };
    }

    // Files of one version can carry different mtimes, so every file is dated
    // by the same probe the metadata filter uses for its version.
    const probed = await this.fetchPublishedViaLastModified(
      groupId,
      artifactId,
      version,
    );
    if (!probed) return null;
    return { packageName, version, published: probed };
  }

  protected async fetchUpstreamXml(req: Request) {
    const base = this.config.upstream.replace(/\/$/, '');
    return axios.get<string>(`${base}${getXmlPath(req.path)}`, {
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  private async fetchVersions(
    metadata: string,
    req: Request,
  ): Promise<VersionMetadata[]> {
    // Group-level metadata lists plugins/artifacts without <versions> — skip search
    if (!metadata.includes('<versions>')) return [];

    const { groupId, artifactId } = parseMavenPath(getXmlPath(req.path));
    const packageName = `${groupId}:${artifactId}`;
    const res = await axios.get<DepsDevPackageResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    const dated: VersionMetadata[] = [];
    if (res.status === 200) {
      for (const v of res.data?.versions ?? []) {
        const published = parseDepsDevDate(v.publishedAt);
        if (published) {
          dated.push({ packageName, version: v.versionKey.version, published });
        }
      }
    }

    // deps.dev lags behind Central and does not know artifacts hosted
    // elsewhere. Those versions are dated by the upstream's Last-Modified; one
    // it cannot date either is left out, and so stays blocked.
    const known = new Set(dated.map((v) => v.version));
    const undated = parseVersionsFromXml(metadata).filter((v) => !known.has(v));
    const probed = await this.probeAll(groupId, artifactId, undated);
    for (const [version, published] of probed) {
      if (published) dated.push({ packageName, version, published });
    }
    return dated;
  }

  /** Probe every version's timestamp, bounded to PROBE_CONCURRENCY at a time. */
  private async probeAll(
    groupId: string,
    artifactId: string,
    versions: string[],
  ): Promise<[string, Date | null][]> {
    const out: [string, Date | null][] = new Array(versions.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= versions.length) return;
        const version = versions[i]!;
        out[i] = [
          version,
          await this.fetchPublishedViaLastModified(groupId, artifactId, version),
        ];
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, versions.length) }, worker),
    );
    return out;
  }

  /**
   * Read a version's publish time from the upstream's `Last-Modified` header.
   * The POM is the probe target: it is the file every release has. An sbt
   * plugin's directory ends in `_<scala>_<sbt>`, which its files may omit, so
   * the POM is also tried without it.
   */
  private async fetchPublishedViaLastModified(
    groupId: string,
    artifactId: string,
    version: string,
  ): Promise<Date | null> {
    const base = this.config.upstream.replace(/\/$/, '');
    const groupPath = groupId.split('.').join('/');
    const pomUrl = (name: string) =>
      `${base}/${groupPath}/${artifactId}/${version}/${name}-${version}.pom`;

    const url = pomUrl(artifactId);
    const published = await pomProbe.get(url, url);
    if (published || !SBT_PLUGIN_SUFFIX.test(artifactId)) return published;

    const bareUrl = pomUrl(artifactId.replace(SBT_PLUGIN_SUFFIX, ''));
    return pomProbe.get(bareUrl, bareUrl);
  }

  private filterXml(
    metadata: string,
    allowedVersions: VersionMetadata[],
  ): string {
    if (!metadata.includes('<versions>')) return metadata;
    // Ties on `published` are common with Last-Modified, since a repository
    // that re-syncs stamps every file alike. The later entry in the document
    // wins a tie.
    const order = new Map(
      parseVersionsFromXml(metadata).map((v, i) => [v, i] as const),
    );
    const latestEntry = allowedVersions.reduce<VersionMetadata | null>(
      (acc, v) => {
        if (!acc) return v;
        if (v.published > acc.published) return v;
        if (v.published < acc.published) return acc;
        return (order.get(v.version) ?? -1) > (order.get(acc.version) ?? -1)
          ? v
          : acc;
      },
      null,
    );
    const allowed = new Set(allowedVersions.map((v) => v.version));
    return (
      filterMavenMetadataXml(
        metadata,
        allowed,
        latestEntry?.version ?? '',
        latestEntry?.published,
      ) ?? ''
    );
  }

  private respondWithMetadata(
    res: Response,
    filteredMetadata: string,
    req: Request,
  ): void {
    if (filteredMetadata === '') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const suffix = req.path.endsWith('.sha1')
      ? 'sha1'
      : req.path.endsWith('.md5')
        ? 'md5'
        : null;
    if (suffix) {
      const hash = createHash(suffix).update(filteredMetadata).digest('hex');
      res.status(200).type('text/plain').send(hash);
    } else {
      res.status(200).type('application/xml').send(filteredMetadata);
    }
  }
}

/**
 * Extract version strings from the `<versions>` block of a maven-metadata.xml,
 * in document order. That is not necessarily publication order.
 */
function parseVersionsFromXml(xml: string): string[] {
  const block = /<versions>([\s\S]*?)<\/versions>/.exec(xml);
  if (!block) return [];
  return [...block[1]!.matchAll(/<version>([^<]*)<\/version>/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

/** deps.dev's `publishedAt`, or null when it is absent or unreadable. */
function parseDepsDevDate(value: unknown): Date | null {
  return parseHttpDate(value);
}

function isMavenMetadataPath(path: string): boolean {
  return (
    path.endsWith('/maven-metadata.xml') ||
    path.endsWith('/maven-metadata.xml.sha1') ||
    path.endsWith('/maven-metadata.xml.md5')
  );
}

/** Returns true for version-specific artifact paths: /{groupId}/{artifactId}/{version}/{file} */
function isMavenDownloadPath(path: string): boolean {
  return path.split('/').filter(Boolean).length >= 4;
}

/**
 * Parse groupId, artifactId, and version from a Maven artifact download path.
 *
 * Example:
 *   /com/example/mylib/1.0.0/mylib-1.0.0.jar
 *   -> groupId: "com.example", artifactId: "mylib", version: "1.0.0"
 */
function parseMavenDownloadPath(path: string): {
  groupId: string;
  artifactId: string;
  version: string;
} | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const version = parts[parts.length - 2];
  const artifactId = parts[parts.length - 3];
  const groupId = parts.slice(0, -3).join('.');
  return { groupId, artifactId, version };
}

function getXmlPath(path: string): string {
  if (path.endsWith('.sha1')) return path.slice(0, -5);
  if (path.endsWith('.md5')) return path.slice(0, -4);
  return path;
}

/**
 * Parse groupId and artifactId from a Maven path.
 *
 * Example:
 *   /com/example/mylib/maven-metadata.xml
 *   -> groupId: "com.example", artifactId: "mylib"
 */
function parseMavenPath(path: string): {
  groupId: string;
  artifactId: string;
} {
  const withoutFile = path.replace(/\/maven-metadata\.xml$/, '');
  const parts = withoutFile.split('/').filter(Boolean);
  const artifactId = parts[parts.length - 1] ?? '';
  const groupId = parts.slice(0, -1).join('.');
  return { groupId, artifactId };
}

/**
 * Filter a maven-metadata.xml string to only include allowed versions.
 *
 * Updates <versions>, the top-level <version>, <release>, <latest>, and
 * <lastUpdated> fields.
 * Returns null when no versions remain after filtering.
 */
function filterMavenMetadataXml(
  xml: string,
  allowedVersions: Set<string>,
  latestVersion: string,
  lastUpdated?: Date,
): string | null {
  let hasAllowedVersions = false;

  // Filter <version> entries inside the <versions> block
  const filtered = xml.replace(
    /(<versions>)([\s\S]*?)(<\/versions>)/,
    (_, open: string, content: string, close: string) => {
      const filteredContent = content.replace(
        /<version>([^<]*)<\/version>/g,
        (match: string, v: string) => {
          if (allowedVersions.has(v.trim())) {
            hasAllowedVersions = true;
            return match;
          }
          return '';
        },
      );
      return `${open}${filteredContent}${close}`;
    },
  );

  if (!hasAllowedVersions) return null;

  // Update the top-level <version>, <release>, <latest>, and <lastUpdated> to reflect the filtered state
  let result = filtered
    .replace(/^[\s\S]*?<versioning>/, (head) =>
      head.replace(/<version>[^<]*<\/version>/, `<version>${latestVersion}</version>`),
    )
    .replace(/<release>[^<]*<\/release>/, `<release>${latestVersion}</release>`)
    .replace(/<latest>[^<]*<\/latest>/, `<latest>${latestVersion}</latest>`);
  if (lastUpdated) {
    result = result.replace(
      /<lastUpdated>[^<]*<\/lastUpdated>/,
      `<lastUpdated>${formatMavenTimestamp(lastUpdated)}</lastUpdated>`,
    );
  }
  return result;
}

/** Format a Date as Maven's `lastUpdated` timestamp: `yyyyMMddHHmmss` in UTC. */
function formatMavenTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
