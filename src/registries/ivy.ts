import type { Request, Response } from 'express';
import axios from 'axios';
import escapeHtml from 'escape-html';
import {
  RegistryProxy,
  type RegistryConfig,
  type VersionMetadata,
} from './base.ts';
import { listFolders, type ArtifactoryEndpoint } from './artifactory.ts';
import { TtlCache } from './ttl-cache.ts';

/** Upper bound on redirect hops when probing a revision's ivy.xml. */
const MAX_REDIRECTS = 3;

/**
 * Dating a revision costs one request, and filtering a listing means dating
 * every revision in it — a module can have hundreds — so the requests are
 * bounded and their results held briefly. The same cache serves the download
 * gate, which asks the same question about one revision.
 */
const PROBE_CONCURRENCY = 8;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 10_000;
const probeCache = new TtlCache<Date | null>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
const listingCache = new TtlCache<string[]>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);

/** How many children are inspected to tell a revision directory from any other. */
const SHAPE_SAMPLE = 3;

/** @internal Reset module-level caches. Used by tests; not part of the public API. */
export function __resetIvyCachesForTesting() {
  probeCache.clear();
  listingCache.clear();
}

export interface IvyRegistryConfig extends RegistryConfig {
  /**
   * Structured source for a module's revision listing, resolved at startup when
   * `--ivy-repo …,index=artifactory` is configured. Unset means dynamic
   * revisions are not filtered — see IvyRegistryProxy.
   */
  endpoint?: ArtifactoryEndpoint;
}

/**
 * Proxy for an Ivy-layout repository.
 *
 * Ivy lays artifacts out as
 * `{org}/{module}(/scala_{v})(/sbt_{v})/{revision}/{type}s/{artifact}(-{classifier}).{ext}`
 * — for example
 * `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.5.6/ivys/ivy.xml`.
 *
 * Every request for a file under a revision is gated on that revision's age,
 * read from the `Last-Modified` of its `ivys/ivy.xml`. Everything else is passed
 * through.
 *
 * **Dynamic revisions need `index`.** Ivy has no document listing a module's
 * revisions; a client discovers them by reading the repository's directory
 * index. Without a way to produce that list, a proxy can only refuse the
 * artifact once the client has chosen it — and the resolver does not then try
 * the next revision. Measured with Coursier 2.1.25 against sbt-plugin-releases:
 * it reads the listing, picks one revision, requests that revision's ivy.xml,
 * and stops at the 404. Nothing inside the cooldown window is served, but a
 * build on `latest.integration` breaks rather than settling for an older
 * revision.
 *
 * Configuring `index=artifactory` lets the proxy answer that listing itself,
 * filtered, so the resolver only ever sees revisions it is allowed to take. The
 * revision names come from Artifactory's storage API as JSON (see
 * ./artifactory.ts) and each one is dated exactly as the download gate dates it,
 * so the two can never disagree. The response is generated from that list:
 * nothing here reads the upstream's HTML, and the only HTML involved is the
 * document this proxy writes, because that is the shape a resolver expects.
 *
 * Which revision the resolver then picks is its own version ordering, not the
 * listing's order: in that run Coursier asked for `1.3.4+151-7c324c7c` while the
 * listing ended at `1.3.4+160-681434ff`.
 *
 * Malicious/allowlist lookups use the shared "maven" ecosystem, since OSV tracks
 * JVM artifacts there regardless of repository layout.
 */
export class IvyRegistryProxy extends RegistryProxy {
  readonly name: string;

  constructor(config: IvyRegistryConfig) {
    super(config);
    this.name = config.name ?? 'ivy';
  }

  /**
   * Read off `config` rather than held in a field: the base constructor calls
   * `setRouting()`, which runs before a subclass's own initialisers, so a field
   * would still be undefined when the routes are registered.
   */
  private get endpoint(): ArtifactoryEndpoint | null {
    return (this.config as IvyRegistryConfig).endpoint ?? null;
  }

  protected override get dbKey(): string {
    return 'maven';
  }

  protected setRouting() {
    this.addDownloadRoute({
      condition: (req) => isIvyDownloadPath(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });

    this.addCustomRoute({
      condition: (req) =>
        this.endpoint !== null && isRevisionListingPath(req.path),
      handle: (req, res) => this.respondRevisionListing(req, res),
    });
  }

  /**
   * Answer a module's revision listing with only the revisions past the
   * cooldown.
   *
   * A path's shape cannot tell a directory of revisions from any other
   * directory: `/ch.epfl.scala/sbt-bloop/` holds `scala_2.12`, and `…/1.5.6/`
   * holds `ivys` and `jars`. Filtering either as if its children were revisions
   * would hide them all, so the children decide. A child that dates is a
   * revision; if none date, the storage API is asked whether any child holds an
   * artifact-type directory — which says the children *are* revisions whose
   * `ivy.xml` cannot be read, and that is refused rather than passed through.
   */
  private async respondRevisionListing(
    req: Request,
    res: Response,
  ): Promise<void> {
    const endpoint = this.endpoint!;
    const modulePath = req.path.replace(/\/+$/, '');
    const children = await this.listChildren(endpoint, modulePath);
    if (children === null) {
      // The listing is what the resolver picks from; serving an unfiltered or
      // partial one would defeat the cooldown, so refuse instead.
      this.refuseListing(res, modulePath, 'could not be listed');
      return;
    }

    const dated = await this.dateRevisions(modulePath, children);
    if (dated.length === 0) {
      if (await this.holdsRevisions(endpoint, modulePath, children)) {
        this.refuseListing(
          res,
          modulePath,
          'holds revisions whose ivy.xml could not be read, so none of them ' +
            'can be shown to be past the cooldown',
        );
        return;
      }
      // Not a revision directory — it has no revisions to filter, so it is none
      // of this route's business.
      await this.handlePassthrough(req, res);
      return;
    }

    const allowed = new Set(this.filterVersions(dated).map((v) => v.version));
    res
      .status(200)
      .type('text/html')
      .send(renderListing(children.filter((c) => allowed.has(c))));
  }

  private refuseListing(res: Response, path: string, why: string): void {
    res.status(502).json({
      error: 'Bad Gateway',
      message: `${path} ${why} via the Artifactory storage API`,
    });
  }

  /**
   * True when a directory's children are revisions rather than, say,
   * cross-version qualifiers: a revision contains Ivy's artifact-type
   * directories (`ivys`, `jars`, …), and nothing else in the layout does.
   *
   * Only the first few children are checked — one answer settles it, and this
   * runs only when no child could be dated.
   */
  private async holdsRevisions(
    endpoint: ArtifactoryEndpoint,
    modulePath: string,
    children: string[],
  ): Promise<boolean> {
    for (const child of children.slice(0, SHAPE_SAMPLE)) {
      const grandchildren = await this.listChildren(
        endpoint,
        `${modulePath}/${child}`,
      );
      if (grandchildren?.some(isArtifactTypeDirectory)) return true;
    }
    return false;
  }

  /** The child folders of a path, cached for CACHE_TTL_MS. */
  private async listChildren(
    endpoint: ArtifactoryEndpoint,
    path: string,
  ): Promise<string[] | null> {
    const key = `${this.name}${path}`;
    const cached = listingCache.get(key);
    if (cached !== undefined) return cached;
    const children = await listFolders(endpoint, path);
    if (children === null) return null;
    listingCache.set(key, children);
    return children;
  }

  /**
   * Date every candidate revision the way a download of it would be dated.
   *
   * A candidate whose timestamp cannot be read is left out: either it is not a
   * revision at all, or its age is unknown, and neither may be offered.
   */
  private async dateRevisions(
    modulePath: string,
    candidates: string[],
  ): Promise<VersionMetadata[]> {
    const dated: VersionMetadata[] = [];
    let next = 0;
    const workers = Math.min(PROBE_CONCURRENCY, candidates.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < candidates.length) {
          const revision = candidates[next++]!;
          const published = await this.revisionPublished(modulePath, revision);
          if (!published) continue;
          dated.push({
            packageName: packageNameFromPath(modulePath),
            version: revision,
            published,
          });
        }
      }),
    );
    return dated;
  }

  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const parsed = parseIvyDownloadPath(req.path);
    if (!parsed) return null;
    const { modulePath, revision } = parsed;
    const published = await this.revisionPublished(modulePath, revision);
    if (!published) return null;
    return {
      packageName: packageNameFromPath(modulePath),
      version: revision,
      published,
    };
  }

  /**
   * When a revision was published, from the `Last-Modified` of its
   * `ivys/ivy.xml`. The one date both the download gate and the listing use, so
   * a revision the listing offers is a revision the gate will pass.
   */
  private async revisionPublished(
    modulePath: string,
    revision: string,
  ): Promise<Date | null> {
    const key = `${this.name}${modulePath}/${revision}`;
    const cached = probeCache.get(key);
    if (cached !== undefined) return cached;
    const published = await this.headIvyXml(modulePath, revision);
    probeCache.set(key, published);
    return published;
  }

  private async headIvyXml(
    modulePath: string,
    revision: string,
  ): Promise<Date | null> {
    const base = this.config.upstream.replace(/\/$/, '');
    // Follow redirects: repo.scala-sbt.org and repo.typesafe.com both 302 to
    // the Artifactory instance that actually holds the file.
    const res = await axios.head(
      `${base}${modulePath}/${revision}/ivys/ivy.xml`,
      { validateStatus: () => true, maxRedirects: MAX_REDIRECTS },
    );
    if (res.status !== 200) return null;
    const lastModified = res.headers['last-modified'];
    if (typeof lastModified !== 'string') return null;
    const published = new Date(lastModified);
    if (Number.isNaN(published.getTime())) return null;
    return published;
  }
}

/**
 * True for a path that *may* be a directory of revisions: a trailing-slash path
 * that is not itself an artifact-type directory.
 *
 * Only the handler can decide whether it really is one, by looking at the
 * children — see respondRevisionListing.
 */
function isRevisionListingPath(path: string): boolean {
  if (!path.endsWith('/') || path === '/') return false;
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  return !isArtifactTypeDirectory(parts[parts.length - 1]!);
}

/**
 * Render a directory index listing the given entries.
 *
 * A resolver only reads the hrefs, so this is deliberately minimal: a generated
 * document, not a rewrite of the upstream's.
 *
 * Revision names go in as they came out of the upstream, escaped for HTML and
 * nothing more. Percent-encoding them looks more correct and is not: Artifactory
 * writes `href="1.0.0-RC1+4-c5e24b66/"` literally, and Coursier 2.1.25 reads the
 * href as written — given `%2B` it finds no revisions at all.
 */
function renderListing(entries: string[]): string {
  const links = entries
    .map((e) => `<a href="${escapeHtml(e)}/">${escapeHtml(e)}/</a>`)
    .join('\n');
  return `<html>\n<body>\n<pre>\n<a href="../">../</a>\n${links}\n</pre>\n</body>\n</html>\n`;
}

/**
 * True for `{...}/{revision}/{type}s/{file}` — the shape of every Ivy artifact
 * fetch. The `{type}s` segment is Ivy's artifact-type directory (`ivys`, `jars`,
 * `poms`, `srcs`, `docs`, …).
 */
function isIvyDownloadPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return false;
  return isArtifactTypeDirectory(parts[parts.length - 2]!);
}

/** Ivy's artifact-type directory, one level below a revision: `ivys`, `jars`, … */
function isArtifactTypeDirectory(segment: string): boolean {
  return /^[a-z]+s$/.test(segment);
}

/**
 * Split an Ivy artifact path into the module directory and the revision.
 *
 * `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.5.6/ivys/ivy.xml`
 *   -> modulePath: "/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0", revision: "1.5.6"
 */
function parseIvyDownloadPath(
  path: string,
): { modulePath: string; revision: string } | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const revision = parts[parts.length - 3]!;
  const modulePath = `/${parts.slice(0, -3).join('/')}`;
  return { modulePath, revision };
}

/**
 * Build the malicious/allowlist lookup key from a module path.
 *
 * Ivy's first two segments are the organisation and the module; the optional
 * `scala_*` / `sbt_*` segments are cross-version qualifiers, not part of the
 * coordinate OSV records.
 */
function packageNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const org = parts[0] ?? '';
  const module = parts[1] ?? '';
  return `${org}:${module}`;
}
