import axios, { type AxiosResponse } from 'axios';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import type { AllowlistDb, MaliciousDb } from '../types.ts';

export interface RegistryConfig {
  /** Upstream registry base URL */
  upstream: string;
  /** Filter out versions published within this many milliseconds */
  delayMs: number;
  /** Path to a single combined malicious DB JSON file (all ecosystems) */
  maliciousDbPath: string;
  /**
   * Optional path to a single combined allowlist JSON file (all ecosystems).
   * Allowlisted entries bypass the age-delay filter; the malicious DB check
   * still applies so explicitly known-bad versions cannot be re-enabled.
   */
  allowlistDbPath?: string;
  /**
   * How passthrough/download requests are served. "direct" (default) responds
   * with a 307 to the upstream URL; "proxied" streams the upstream response
   * back through the proxy so clients never talk to the upstream directly.
   */
  upstreamAccess?: 'direct' | 'proxied';
  /**
   * Absolute base URL of the proxy (e.g. "https://tengen.example.com", no
   * trailing slash). In `proxied` mode it is used to rewrite upstream artifact URLs
   * embedded in metadata so clients fetch through the proxy; in `direct` mode,
   * or when unset, those URLs are left pointing at the upstream.
   */
  baseUrl?: string;
  /**
   * Overrides the registry's URL prefix and display name. Used to mount several
   * instances of the same proxy class at different paths — e.g. additional Maven
   * repositories declared with `--maven-repo <name>=<url>`. Registries with a
   * fixed name ignore this.
   */
  name?: string;
  /**
   * Where a Maven-layout registry reads version publish timestamps from:
   * - "deps-dev" (default): query the deps.dev API. A version deps.dev has no
   *   record of stays blocked (fail-closed).
   * - "last-modified": HEAD the version's POM on the upstream and use its
   *   `Last-Modified` header.
   *
   * The two are exclusive. deps.dev only indexes Maven Central, so a repository
   * other than Central must use "last-modified" — with "deps-dev" every version
   * would be unknown and its metadata would come back empty. Ignored by
   * non-Maven registries.
   */
  timestampSource?: 'deps-dev' | 'last-modified';
}

export interface VersionMetadata {
  packageName: string;
  version: string;
  published: Date;
}

interface DownloadRouting<
  VersionMetadataType extends VersionMetadata = VersionMetadata,
> {
  condition: (req: Request) => boolean;
  /**
   * Extract the VersionMetadata for the requested download.
   * Passed to filterVersions to check delay and malicious DB.
   * Return null to block the request (treated the same as a version that fails filtering).
   */
  getVersionMetadata: (
    req: Request,
  ) => Promise<VersionMetadataType | null> | VersionMetadataType | null;
  /** Called when the version is blocked (default: 404 JSON response) */
  respondBlocked?: (res: Response, req: Request) => void;
}

interface MetadataRouting<MetadataType, VersionMetadataType = VersionMetadata> {
  condition: (req: Request) => boolean;
  requestUpstream?: (
    originalReq: Request,
  ) => Promise<AxiosResponse<MetadataType, any, {}>>;
  getVersions: (
    metadata: MetadataType,
    req: Request,
  ) => Promise<VersionMetadataType[]> | VersionMetadataType[];
  filterMetadata: (
    metadata: MetadataType,
    allowedVersions: VersionMetadataType[],
    req: Request,
  ) => Promise<MetadataType> | MetadataType;
  respond?: (
    res: Response,
    filteredMetadata: MetadataType,
    req: Request,
  ) => void;
}

interface CustomRouting {
  condition: (req: Request) => boolean;
  handle: (req: Request, res: Response) => Promise<void> | void;
}

/**
 * Base class for registry proxies.
 *
 * To add a new registry, extend this class, override `setRouting()`, and register
 * routes with `addMetadataRoute()` or `addDownloadRoute()`. For special-case
 * behaviour, add additional routes in `setRouting()` with custom `requestUpstream`,
 * `filterMetadata`, and `respond` callbacks.
 */
let cachedCombinedDb: MaliciousDb | null | undefined;
let cachedCombinedAllowlist: AllowlistDb | null | undefined;

/**
 * Connection-level (hop-by-hop) headers that describe the proxy↔upstream socket
 * rather than the end-to-end payload. They must be dropped when piping a
 * response, otherwise Node re-frames the body and conflicting values (e.g. a
 * forwarded `transfer-encoding: chunked`) corrupt the client-facing response.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'upgrade',
]);

/** @internal Reset module-level caches. Used by tests; not part of the public API. */
export function __resetCachesForTesting() {
  cachedCombinedDb = undefined;
  cachedCombinedAllowlist = undefined;
}

export abstract class RegistryProxy {
  /** The human-readable name of this registry (e.g. "npm", "pypi"). Also the URL prefix. */
  abstract readonly name: string;
  /**
   * Ecosystem key used to look up entries in the malicious and allowlist DBs.
   * Defaults to `name`, but a registry whose artifacts are tracked under a
   * different ecosystem (e.g. Gradle plugins are Maven artifacts in OSV) can
   * override this to share another registry's DB section.
   */
  protected get dbKey(): string {
    return this.name;
  }
  protected readonly config: RegistryConfig;
  private readonly routing: CustomRouting[] = [];
  private cachedMaliciousDb:
    | { packages: Set<string>; versions: Map<string, Set<string>> }
    | null
    | undefined = undefined;
  private cachedAllowlist:
    | { packages: Set<string>; versions: Map<string, Set<string>> }
    | null
    | undefined = undefined;

  constructor(config: RegistryConfig) {
    this.config = config;
    this.setRouting();
  }

  protected setRouting() {}

  protected addMetadataRoute<T, U extends VersionMetadata = VersionMetadata>(
    route: MetadataRouting<T, U>,
  ) {
    this.routing.push({
      condition: route.condition,
      handle: async (req, res) =>
        await this.handleMetadataRoute(route, req, res),
    });
  }

  protected addDownloadRoute<U extends VersionMetadata = VersionMetadata>(
    route: DownloadRouting<U>,
  ) {
    this.routing.push({
      condition: route.condition,
      handle: async (req, res) =>
        await this.handleDownloadRoute(route, req, res),
    });
  }

  protected addPassthroughRoute(condition: (req: Request) => boolean) {
    this.routing.push({
      condition,
      handle: (req, res) => this.handlePassthrough(req, res),
    });
  }

  protected addCustomRoute(route: CustomRouting) {
    this.routing.push(route);
  }

  /** Build the full upstream URL from an incoming request. */
  protected buildUpstreamUrl(req: Request): string {
    const base = this.config.upstream.replace(/\/$/, '');
    const reqUrl = new URL(req.url, 'http://dummy');
    return `${base}${reqUrl.pathname}${reqUrl.search}`;
  }

  /** Entry point called by the Express router for every incoming request. */
  async handleRequest(req: Request, res: Response) {
    for (const route of this.routing) {
      if (!route.condition(req)) continue;
      await route.handle(req, res);
      return;
    }
    await this.handlePassthrough(req, res);
  }

  private async handleMetadataRoute(
    route: MetadataRouting<any, any>,
    req: Request,
    res: Response,
  ) {
    route.requestUpstream ??= (origReq) =>
      axios.get(this.buildUpstreamUrl(origReq), {
        validateStatus: () => true,
        maxRedirects: 0,
      });
    const response = await route.requestUpstream(req);
    if (response.status !== 200) {
      if (response.headers['location']) {
        const location = response.headers['location'];
        try {
          const locationUrl = new URL(location);
          const upstreamUrl = new URL(this.config.upstream);
          if (locationUrl.origin === upstreamUrl.origin) {
            res.set(
              'location',
              '/' +
                this.name +
                locationUrl.pathname +
                locationUrl.search +
                locationUrl.hash,
            );
          } else {
            res.set('location', location);
          }
        } catch {
          res.set('location', location);
        }
      }
      res
        .status(response.status)
        .type(response.headers['content-type'] || 'application/json')
        .send(response.data);
      return;
    }
    const metadata = response.data;
    const versions = await route.getVersions(metadata, req);
    const filteredVersions = this.filterVersions(versions);
    const filteredMetadata = await route.filterMetadata(
      metadata,
      filteredVersions,
      req,
    );
    if (route.respond) {
      route.respond(res, filteredMetadata, req);
    } else {
      res.status(200).json(filteredMetadata);
    }
  }

  private async handleDownloadRoute(
    route: DownloadRouting<any>,
    req: Request,
    res: Response,
  ) {
    const versionMeta = await route.getVersionMetadata(req);
    if (
      versionMeta === null ||
      this.filterVersions([versionMeta]).length === 0
    ) {
      if (route.respondBlocked) {
        route.respondBlocked(res, req);
      } else {
        res.status(404).json({ error: 'Version not allowed' });
      }
      return;
    }
    await this.handlePassthrough(req, res);
  }

  protected async handlePassthrough(
    req: Request,
    res: Response,
  ): Promise<void> {
    if (this.config.upstreamAccess === 'proxied') {
      await this.pipePassthrough(req, res);
      return;
    }
    const url = this.buildUpstreamUrl(req);
    // Always use 307 so the client preserves the original HTTP method (e.g.
    // POST for npm audit). 302 allows clients to switch to GET, which causes
    // upstream to return 405 Method Not Allowed.
    res.redirect(307, url);
  }

  /**
   * Stream the upstream response back through the proxy instead of redirecting.
   * Used when clients can only reach the proxy directly (not the upstream).
   */
  private async pipePassthrough(req: Request, res: Response): Promise<void> {
    const url = this.buildUpstreamUrl(req);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    // Forward the client's request headers (e.g. content-encoding for npm
    // audit's gzipped POST body) except hop-by-hop headers and host, which
    // must reflect the upstream target rather than the proxy.
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (lower === 'host') continue;
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      headers[key] = value;
    }

    const upstream = await axios.request({
      url,
      method: req.method,
      headers,
      data: hasBody ? req : undefined,
      responseType: 'stream',
      decompress: false,
      validateStatus: () => true,
    });

    res.status(upstream.status);
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      res.setHeader(key, value as string | string[]);
    }

    const stream = upstream.data as NodeJS.ReadableStream;
    stream.on('error', (err) => {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } else {
        res.status(502).json({ error: 'Bad Gateway', message: String(err) });
      }
    });
    stream.pipe(res);
  }

  private getMaliciousDB(): {
    packages: Set<string>;
    versions: Map<string, Set<string>>;
  } | null {
    if (this.cachedMaliciousDb !== undefined) return this.cachedMaliciousDb;
    try {
      const dbPath = this.config.maliciousDbPath;
      if (cachedCombinedDb === undefined) {
        const content = readFileSync(dbPath, 'utf-8');
        cachedCombinedDb = JSON.parse(content) as MaliciousDb;
      }
      const raw = cachedCombinedDb?.[this.dbKey];
      if (!raw) {
        this.cachedMaliciousDb = null;
        return null;
      }
      this.cachedMaliciousDb = {
        packages: new Set(raw.maliciousPackages),
        versions: new Map(
          Object.entries(raw.maliciousVersions).map(([pkg, vs]) => [
            pkg,
            new Set(vs),
          ]),
        ),
      };
    } catch {
      this.cachedMaliciousDb = null;
    }
    return this.cachedMaliciousDb;
  }

  private getAllowlistDB(): {
    packages: Set<string>;
    versions: Map<string, Set<string>>;
  } | null {
    if (this.cachedAllowlist !== undefined) return this.cachedAllowlist;
    const dbPath = this.config.allowlistDbPath;
    if (!dbPath) {
      this.cachedAllowlist = null;
      return null;
    }
    try {
      if (cachedCombinedAllowlist === undefined) {
        const content = readFileSync(dbPath, 'utf-8');
        cachedCombinedAllowlist = JSON.parse(content) as AllowlistDb;
      }
      const raw = cachedCombinedAllowlist?.[this.dbKey];
      if (!raw) {
        this.cachedAllowlist = null;
        return null;
      }
      this.cachedAllowlist = {
        packages: new Set(raw.allowlistedPackages),
        versions: new Map(
          Object.entries(raw.allowlistedVersions).map(([pkg, vs]) => [
            pkg,
            new Set(vs),
          ]),
        ),
      };
    } catch {
      this.cachedAllowlist = null;
    }
    return this.cachedAllowlist;
  }

  protected filterVersions(versions: VersionMetadata[]) {
    if (versions.length === 0) return [];

    const allowlist = this.getAllowlistDB();
    const packageName = versions[0].packageName;
    const isPackageAllowlisted =
      allowlist !== null && allowlist.packages.has(packageName);
    const allowlistedVersionSet = allowlist?.versions.get(packageName);

    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    let filtered = versions.filter(
      (v) =>
        v.published <= cutoffDate ||
        isPackageAllowlisted ||
        allowlistedVersionSet?.has(v.version) === true,
    );
    if (filtered.length === 0) return [];

    const db = this.getMaliciousDB();
    if (db !== null) {
      if (db.packages.has(packageName)) {
        return [];
      }
      const maliciousVersionSet = db.versions.get(packageName);
      if (maliciousVersionSet !== undefined) {
        filtered = filtered.filter((v) => !maliciousVersionSet.has(v.version));
      }
    }

    return filtered;
  }
}
