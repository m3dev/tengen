import type { Request, Response } from 'express';
import axios from 'axios';
import { createHash } from 'node:crypto';
import {
  RegistryProxy,
  type RegistryConfig,
  type VersionMetadata,
} from './base.ts';
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
 * Without a cache every metadata request re-probes every version. The window is
 * short because a repository can rewrite an artifact's mtime on re-sync, and a
 * stale value would keep serving a version whose timestamp has since moved
 * forward into the cooldown window.
 */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** How many probed timestamps are kept before the oldest are dropped. */
const PROBE_CACHE_MAX = 10_000;

/**
 * Version timestamps keyed by URL and shared across registry instances. The
 * metadata filter and the download gate read the same entries.
 */
const versionProbe = new LastModifiedProbe(PROBE_TTL_MS, PROBE_CACHE_MAX);

/** @internal Reset the probe cache. Used by tests; not part of the public API. */
export function __resetProbeCacheForTesting() {
  versionProbe.clear();
}

/** Upper bound on redirect hops when resolving metadata. */
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
   * exclusive: with "deps-dev" a version deps.dev has no record of is unknown
   * and stays blocked.
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
      getVersions: (metadata, req, upstream) =>
        this.fetchVersions(metadata, req, upstream.headers['last-modified']),
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
      // Files of one version can carry different mtimes, so every file is
      // dated by the same probe the metadata filter uses for its version.
      const published = await this.fetchPublishedViaLastModified(
        groupId,
        artifactId,
        version,
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
    documentModified: unknown,
  ): Promise<VersionMetadata[]> {
    // A version-level maven-metadata.xml describes one timestamped SNAPSHOT
    // build. Its own Last-Modified dates it, the same value the artifact-level
    // filter and the download gate read for this version.
    if (isSnapshotMetadata(metadata)) {
      return snapshotVersions(
        metadata,
        getXmlPath(req.path),
        parseHttpDate(documentModified),
      );
    }

    // Group-level metadata lists plugins/artifacts without <versions> — skip search
    if (!metadata.includes('<versions>')) return [];

    const { groupId, artifactId } = parseMavenPath(getXmlPath(req.path));
    const packageName = `${groupId}:${artifactId}`;

    if (this.timestampSource === 'last-modified') {
      return this.fetchVersionsViaLastModified(
        metadata,
        groupId,
        artifactId,
        parseHttpDate(documentModified),
      );
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
   * `maven-metadata.xml` carries no per-version timestamps, so each version is
   * probed through its POM. The document is rewritten whenever a version is
   * added, so when the upstream's own `Last-Modified` for it is past the cutoff
   * every listed version is older still and none need probing. `<lastUpdated>`
   * is only allowed to make that bound later, never earlier: the deploying
   * client writes it, so it can be stale or wrong.
   *
   * Otherwise every version is probed, in parallel and through a short-lived
   * cache. `<versions>` is not in publication order —
   * `org.apache.logging.log4j:log4j-core` ends its list at a 2024 prerelease
   * while its newest release is from 2026 — so no part of the list can be
   * skipped. Versions whose timestamp cannot be read are excluded.
   */
  private async fetchVersionsViaLastModified(
    metadata: string,
    groupId: string,
    artifactId: string,
    documentModified: Date | null,
  ): Promise<VersionMetadata[]> {
    const packageName = `${groupId}:${artifactId}`;
    const versions = parseVersionsFromXml(metadata);
    if (versions.length === 0) return [];

    if (documentModified) {
      const cutoff = new Date(Date.now() - this.config.delayMs);
      const lastUpdated = parseMetadataLastUpdated(metadata);
      const rewritten =
        lastUpdated && lastUpdated > documentModified
          ? lastUpdated
          : documentModified;
      if (rewritten < cutoff) {
        return versions.map((version) => ({
          packageName,
          version,
          published: rewritten,
        }));
      }
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
    const url = `${dir}/${file}`;
    return versionProbe.get(url, url);
  }

  private filterXml(
    metadata: string,
    allowedVersions: VersionMetadata[],
  ): string {
    // A snapshot's metadata describes a single build (one entry per extension
    // and classifier), so it is served whole or not at all. An empty
    // allowedVersions means that build is inside the cooldown window.
    if (isSnapshotMetadata(metadata)) {
      return allowedVersions.length > 0 ? metadata : '';
    }

    if (!metadata.includes('<versions>')) return metadata;
    const listed = parseVersionsFromXml(metadata);
    const allowed = new Set(allowedVersions.map((v) => v.version));
    if (listed.length > 0 && listed.every((v) => allowed.has(v))) {
      return metadata;
    }

    // The upstream's <release> and <latest> stand while they are still
    // allowed. Only a hidden one is replaced, by the newest allowed version.
    // Ties on `published` are common with the last-modified source, since a
    // repository that re-syncs stamps every file alike; the later entry in the
    // document wins a tie.
    const order = new Map(listed.map((v, i) => [v, i] as const));
    const newest = (candidates: VersionMetadata[]) =>
      candidates.reduce<VersionMetadata | null>((acc, v) => {
        if (!acc) return v;
        if (v.published > acc.published) return v;
        if (v.published < acc.published) return acc;
        return (order.get(v.version) ?? -1) > (order.get(acc.version) ?? -1)
          ? v
          : acc;
      }, null);
    const newestEntry = newest(allowedVersions);
    const upstreamLatest = readVersioningTag(metadata, 'latest');
    const latest =
      upstreamLatest && allowed.has(upstreamLatest)
        ? upstreamLatest
        : (newestEntry?.version ?? '');
    const upstreamRelease = readVersioningTag(metadata, 'release');
    const release =
      upstreamRelease &&
      allowed.has(upstreamRelease) &&
      !upstreamRelease.endsWith('-SNAPSHOT')
        ? upstreamRelease
        : (newest(
            allowedVersions.filter((v) => !v.version.endsWith('-SNAPSHOT')),
          )?.version ?? null);
    return (
      filterMavenMetadataXml(
        metadata,
        allowed,
        latest,
        release,
        newestEntry?.published,
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
 * maven-metadata.xml and its checksums can sit at the same depth but are not
 * artifacts, so they are excluded.
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
 * in document order. That is not necessarily publication order.
 */
function parseVersionsFromXml(xml: string): string[] {
  const block = /<versions>([\s\S]*?)<\/versions>/.exec(xml);
  if (!block) return [];
  return [...block[1]!.matchAll(/<version>([^<]*)<\/version>/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

function readVersioningTag(
  xml: string,
  tag: 'latest' | 'release',
): string | null {
  const value = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]?.trim();
  return value ? value : null;
}

/**
 * True for a version-level (snapshot) maven-metadata.xml. Maven 3 writes
 * `<snapshotVersions>`; Maven 2 writes only `<snapshot>`.
 */
function isSnapshotMetadata(xml: string): boolean {
  return xml.includes('<snapshot>') || xml.includes('<snapshotVersions>');
}

/**
 * Date a version-level (snapshot) maven-metadata.xml.
 *
 * The document describes one timestamped build — `<snapshotVersions>` lists it
 * once per extension and classifier — so a single VersionMetadata represents
 * the whole file. It is dated by the upstream's `Last-Modified` for the
 * document. The build time written inside it can only make that later, never
 * earlier, because the deploying client writes it.
 *
 * Returns an empty list without a `Last-Modified`, which blocks the metadata
 * rather than serving a build of unknown age.
 */
function snapshotVersions(
  xml: string,
  path: string,
  documentModified: Date | null,
): VersionMetadata[] {
  if (!documentModified) return [];
  const { groupId, artifactId } = parseSnapshotPath(path);
  const version = /<version>([^<]+)<\/version>/.exec(xml)?.[1]?.trim() ?? '';
  const built = parseSnapshotTimestamp(xml);
  const published =
    built && built > documentModified ? built : documentModified;
  return [{ packageName: `${groupId}:${artifactId}`, version, published }];
}

/**
 * Parse the `<lastUpdated>` of an artifact-level maven-metadata.xml, which the
 * deploying client writes when it rewrites the document.
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
 * Updates <versions>, <release>, <latest>, and <lastUpdated> fields. <release>
 * is dropped when no release version remains, since it must not name a
 * SNAPSHOT. Returns null when no versions remain after filtering.
 */
function filterMavenMetadataXml(
  xml: string,
  allowedVersions: Set<string>,
  latestVersion: string,
  releaseVersion: string | null,
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
  const release =
    releaseVersion === null ? '' : `<release>${releaseVersion}</release>`;
  let result = filtered
    .replace(/<release>[^<]*<\/release>/, release)
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
