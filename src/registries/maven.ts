import type { Request, Response } from 'express';
import axios from 'axios';
import { createHash } from 'node:crypto';
import {
  RegistryProxy,
  type RegistryConfig,
  type VersionMetadata,
} from './base.ts';
import { TtlCache } from './ttl-cache.ts';

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
 * Without a cache every metadata request re-probes every version. The window is
 * short because a repository can rewrite an artifact's mtime on re-sync, and a
 * stale value would keep serving a version whose timestamp has since moved
 * forward into the cooldown window.
 */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** How many probed timestamps are kept before the oldest are dropped. */
const PROBE_CACHE_MAX = 10_000;

/** `url -> published`, shared across registry instances. */
const probeCache = new TtlCache<Date | null>(PROBE_TTL_MS, PROBE_CACHE_MAX);

/** @internal Reset the probe cache. Used by tests; not part of the public API. */
export function __resetProbeCacheForTesting() {
  probeCache.clear();
}

/** Upper bound on redirect hops when resolving metadata or probing a POM. */
const MAX_METADATA_REDIRECTS = 3;

/** Statuses that carry a `Location` worth following for a GET/HEAD. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class MavenRegistryProxy extends RegistryProxy {
  readonly name: string;

  constructor(config: RegistryConfig) {
    super(config);
    this.name = config.name ?? 'maven';
  }

  /**
   * deps.dev only indexes Maven Central, so a repository other than Central has
   * to read timestamps from its own `Last-Modified` headers. The two sources are
   * exclusive: with "deps-dev" a missing deps.dev record leaves the version
   * unknown and it stays blocked, which is the existing fail-closed behaviour
   * for Central and is deliberately not softened here.
   */
  protected get timestampSource(): 'deps-dev' | 'last-modified' {
    return this.config.timestampSource ?? 'deps-dev';
  }

  /**
   * Routes requests:
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml         → filtered XML metadata
   *   /{...}/maven-metadata.xml.{sha1,md5,sha256,sha512}         → checksum of filtered XML
   *   /{...}/{version}/maven-metadata.xml                        → filtered snapshot metadata
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

    if (this.timestampSource === 'last-modified') {
      // Probe the requested file itself rather than a constructed POM path: a
      // snapshot artifact is named {artifact}-{version}-{timestamp}-{build}.ext
      // and has no {artifact}-{version}.pom beside it, so deriving the POM name
      // would 404 and block every snapshot download.
      const published = await this.fetchLastModified(
        `${this.config.upstream.replace(/\/$/, '')}${req.path}`,
      );
      if (!published) return null;
      return { packageName, version, published };
    }

    const res = await axios.get<DepsDevVersionResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}/versions/${encodeURIComponent(version)}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status !== 200 || !res.data?.publishedAt) return null;
    return {
      packageName,
      version: res.data.versionKey.version,
      published: new Date(res.data.publishedAt),
    };
  }

  /**
   * Fetch the upstream maven-metadata.xml, following redirects server-side.
   *
   * Several Maven repositories answer metadata with a redirect rather than the
   * document — `repo.scala-sbt.org/scalasbt/maven-releases` 302s to Central and
   * `maven.google.com` 301s to `dl.google.com`, for two. Handing that redirect
   * to the client would send it straight to the upstream and bypass the age and
   * malicious filters entirely, so the hops are followed here and the resolved
   * document is filtered as usual.
   */
  protected async fetchUpstreamXml(req: Request) {
    const base = this.config.upstream.replace(/\/$/, '');
    let url = `${base}${getXmlPath(req.path)}`;
    let res = await axios.get<string>(url, {
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
    });

    for (let hops = 0; hops < MAX_METADATA_REDIRECTS; hops++) {
      const location = res.headers['location'];
      if (!REDIRECT_STATUSES.has(res.status) || typeof location !== 'string') {
        return res;
      }
      try {
        url = new URL(location, url).toString();
      } catch {
        return res;
      }
      res = await axios.get<string>(url, {
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
      });
    }

    // Still redirecting after the cap. Handing this back would let the base
    // class forward the redirect, and the client would then fetch the metadata
    // from the upstream unfiltered — the very bypass the loop above exists to
    // close. Refuse instead.
    if (REDIRECT_STATUSES.has(res.status)) {
      return {
        ...res,
        status: 502,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          error: 'Bad Gateway',
          message: `metadata for ${getXmlPath(req.path)} redirected more than ${MAX_METADATA_REDIRECTS} times`,
        }),
      };
    }
    return res;
  }

  private async fetchVersions(
    metadata: string,
    req: Request,
  ): Promise<VersionMetadata[]> {
    // A version-level maven-metadata.xml describes one timestamped SNAPSHOT
    // build and carries its own timestamp, so it needs neither deps.dev nor a
    // probe.
    if (metadata.includes('<snapshotVersions>')) {
      return snapshotVersions(metadata, getXmlPath(req.path));
    }

    // Group-level metadata lists plugins/artifacts without <versions> — skip search
    if (!metadata.includes('<versions>')) return [];

    const { groupId, artifactId } = parseMavenPath(getXmlPath(req.path));
    const packageName = `${groupId}:${artifactId}`;

    if (this.timestampSource === 'last-modified') {
      return this.fetchVersionsViaLastModified(metadata, groupId, artifactId);
    }

    const res = await axios.get<DepsDevPackageResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status !== 200 || !res.data?.versions) return [];
    return res.data.versions.map((v) => ({
      packageName,
      version: v.versionKey.version,
      published: new Date(v.publishedAt),
    }));
  }

  /**
   * Resolve publish timestamps from the upstream's `Last-Modified` headers.
   *
   * `maven-metadata.xml` carries no per-version timestamps, so each version has
   * to be probed — but `<lastUpdated>` records when the metadata was last
   * rewritten, which is the moment the newest version appeared. When that is
   * already past the cutoff, every version in the document is older still and
   * none need probing: the document's own timestamp answers for all of them,
   * and it is an upper bound on each version's publish time, so it is safe to
   * report as such.
   *
   * Otherwise something landed inside the cooldown window and every version is
   * probed, in parallel and through a short-lived cache. Versions whose
   * timestamp cannot be read are excluded rather than assumed old enough.
   *
   * Note that `<versions>` is *not* in publication order — a maintenance
   * release lands after the next minor's first prerelease, and
   * `org.apache.logging.log4j:log4j-core` ends its list at a 2024 prerelease
   * while its newest release is from 2026. Anything that walks the list and
   * stops early is therefore unsound.
   */
  private async fetchVersionsViaLastModified(
    metadata: string,
    groupId: string,
    artifactId: string,
  ): Promise<VersionMetadata[]> {
    const packageName = `${groupId}:${artifactId}`;
    const versions = parseVersionsFromXml(metadata);
    if (versions.length === 0) return [];

    const cutoff = new Date(Date.now() - this.config.delayMs);
    const lastUpdated = parseMetadataLastUpdated(metadata);
    if (lastUpdated && lastUpdated < cutoff) {
      return versions.map((version) => ({
        packageName,
        version,
        published: lastUpdated,
      }));
    }

    const probed = await this.probeAll(groupId, artifactId, versions);
    const resolved: VersionMetadata[] = [];
    for (const [version, published] of probed) {
      if (!published) continue;
      resolved.push({ packageName, version, published });
    }
    return resolved;
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
   *
   * The POM is the file every release has, so it is the probe target. A
   * `-SNAPSHOT` version has no `{artifact}-{version}.pom` — its artifacts are
   * timestamped — but its version directory carries a `maven-metadata.xml`
   * that is rewritten on every build, so that stands in as the probe.
   */
  private async fetchPublishedViaLastModified(
    groupId: string,
    artifactId: string,
    version: string,
  ): Promise<Date | null> {
    const base = this.config.upstream.replace(/\/$/, '');
    const groupPath = groupId.split('.').join('/');
    const dir = `${base}/${groupPath}/${artifactId}/${version}`;
    const file = version.endsWith('-SNAPSHOT')
      ? 'maven-metadata.xml'
      : `${artifactId}-${version}.pom`;
    return this.fetchLastModified(`${dir}/${file}`);
  }

  /** HEAD a URL and read its `Last-Modified` header, cached for PROBE_TTL_MS. */
  private async fetchLastModified(url: string): Promise<Date | null> {
    const hit = probeCache.get(url);
    if (hit !== undefined) return hit;
    const published = await this.headLastModified(url);
    probeCache.set(url, published);
    return published;
  }

  private async headLastModified(url: string): Promise<Date | null> {
    // Follow redirects: a repository may point at where the artifact really
    // lives (e.g. repo.scala-sbt.org 302s to Central), and that is the file
    // whose timestamp matters.
    const res = await axios.head(url, {
      validateStatus: () => true,
      maxRedirects: MAX_METADATA_REDIRECTS,
    });
    if (res.status !== 200) return null;
    const lastModified = res.headers['last-modified'];
    if (typeof lastModified !== 'string') return null;
    const published = new Date(lastModified);
    return Number.isNaN(published.getTime()) ? null : published;
  }

  private filterXml(
    metadata: string,
    allowedVersions: VersionMetadata[],
  ): string {
    // A snapshot's metadata describes a single build (one entry per extension
    // and classifier), so it is served whole or not at all. An empty
    // allowedVersions means that build is inside the cooldown window.
    if (metadata.includes('<snapshotVersions>')) {
      return allowedVersions.length > 0 ? metadata : '';
    }

    if (!metadata.includes('<versions>')) return metadata;
    // Ties on `published` are normal with the last-modified source — a
    // repository that re-syncs stamps every file with the same mtime, and one
    // observed Ivy module has all 382 of its revisions at the same minute. Fall
    // back to the document's own ordering, where Maven puts the newest last.
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
    const suffix = metadataChecksum(req.path);
    if (suffix) {
      const hash = createHash(suffix).update(filteredMetadata).digest('hex');
      res.status(200).type('text/plain').send(hash);
    } else {
      res.status(200).type('application/xml').send(filteredMetadata);
    }
  }
}

/**
 * Checksums a Maven client may ask for alongside maven-metadata.xml.
 *
 * The metadata served here is filtered, so its checksums have to be recomputed
 * over the filtered document — returning the upstream's checksum would not
 * match what the client just received. Maven 3.9 and Gradle both use sha256 and
 * sha512, so limiting this to sha1/md5 breaks them.
 */
const METADATA_CHECKSUMS = ['sha1', 'md5', 'sha256', 'sha512'] as const;

type MetadataChecksum = (typeof METADATA_CHECKSUMS)[number];

const METADATA_PATH = new RegExp(
  `/maven-metadata\\.xml(\\.(?:${METADATA_CHECKSUMS.join('|')}))?$`,
);

function isMavenMetadataPath(path: string): boolean {
  return METADATA_PATH.test(path);
}

/** The checksum a metadata request asks for, or null for the document itself. */
function metadataChecksum(path: string): MetadataChecksum | null {
  const match = METADATA_PATH.exec(path);
  const suffix = match?.[1];
  return suffix ? (suffix.slice(1) as MetadataChecksum) : null;
}

/**
 * Returns true for version-specific artifact paths:
 * `/{groupId}/{artifactId}/{version}/{file}`.
 *
 * maven-metadata.xml and its checksums live at the same depth but are not
 * artifacts — treating `/org/apache/commons/commons-lang3/maven-metadata.xml.sha512`
 * as a download parsed `commons-lang3` as the version and 404'd the request.
 */
function isMavenDownloadPath(path: string): boolean {
  if (isMavenMetadataPath(path)) return false;
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

/**
 * Extract version strings from the `<versions>` block of a maven-metadata.xml,
 * preserving document order (Maven appends, so this is ascending publication
 * order).
 */
function parseVersionsFromXml(xml: string): string[] {
  const block = /<versions>([\s\S]*?)<\/versions>/.exec(xml);
  if (!block) return [];
  return [...block[1]!.matchAll(/<version>([^<]*)<\/version>/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

/**
 * Read the build timestamp out of a version-level (snapshot) maven-metadata.xml.
 *
 * The document describes one timestamped build — `<snapshotVersions>` lists it
 * once per extension and classifier — so a single VersionMetadata represents
 * the whole file. `<lastUpdated>` (yyyyMMddHHmmss, UTC) is the build's time;
 * `<snapshot><timestamp>` (yyyyMMdd.HHmmss) is the same instant and is used as
 * a fallback.
 *
 * Returns an empty list when no timestamp can be read, which blocks the
 * metadata rather than serving a build of unknown age.
 */
function snapshotVersions(xml: string, path: string): VersionMetadata[] {
  const { groupId, artifactId } = parseSnapshotPath(path);
  const version = /<version>([^<]+)<\/version>/.exec(xml)?.[1]?.trim() ?? '';
  const published = parseSnapshotTimestamp(xml);
  if (!published) return [];
  return [{ packageName: `${groupId}:${artifactId}`, version, published }];
}

/**
 * Parse the `<lastUpdated>` of an artifact-level maven-metadata.xml.
 *
 * It records when the document was last rewritten, i.e. when its newest version
 * appeared, so it is an upper bound on every listed version's publish time.
 */
function parseMetadataLastUpdated(xml: string): Date | null {
  const raw = /<lastUpdated>(\d{14})<\/lastUpdated>/.exec(xml)?.[1];
  return raw ? parseCompactUtc(raw) : null;
}

/** Parse `<lastUpdated>`, falling back to `<snapshot><timestamp>`. */
function parseSnapshotTimestamp(xml: string): Date | null {
  const lastUpdated = /<lastUpdated>(\d{14})<\/lastUpdated>/.exec(xml)?.[1];
  if (lastUpdated) return parseCompactUtc(lastUpdated);
  const stamp = /<timestamp>(\d{8})\.(\d{6})<\/timestamp>/.exec(xml);
  if (stamp) return parseCompactUtc(`${stamp[1]}${stamp[2]}`);
  return null;
}

/** Parse a `yyyyMMddHHmmss` string as UTC. */
function parseCompactUtc(v: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse groupId and artifactId from a version-level metadata path.
 *
 * `/org/apache/maven/maven-core/4.1.0-SNAPSHOT/maven-metadata.xml`
 *   -> groupId "org.apache.maven", artifactId "maven-core"
 *
 * The plain parseMavenPath would read the version as the artifactId here.
 */
function parseSnapshotPath(path: string): {
  groupId: string;
  artifactId: string;
} {
  const parts = path
    .replace(/\/maven-metadata\.xml$/, '')
    .split('/')
    .filter(Boolean);
  const artifactId = parts[parts.length - 2] ?? '';
  const groupId = parts.slice(0, -2).join('.');
  return { groupId, artifactId };
}

/** Strip a checksum suffix to get the path of the metadata document itself. */
function getXmlPath(path: string): string {
  const checksum = metadataChecksum(path);
  return checksum ? path.slice(0, -(checksum.length + 1)) : path;
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
 * Updates <versions>, <release>, <latest>, and <lastUpdated> fields.
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

  // Update <release>, <latest>, and <lastUpdated> to reflect the filtered state
  let result = filtered
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
