import axios from 'axios';
import { TtlCache } from './ttl-cache.ts';

/** Upper bound on redirect hops when probing a file. */
const MAX_REDIRECTS = 3;

/** How long a single probe may take before it counts as a transient failure. */
const TIMEOUT_MS = 10_000;

/**
 * Reads publish timestamps from upstream `Last-Modified` headers.
 *
 * A probe never throws: a timestamp that cannot be read is null, and the caller
 * treats the version as unknown. Only a definitive answer (200 or 404/410) is
 * cached, so a 429, a 5xx or a network error blocks the version for the current
 * request alone. Concurrent probes of the same key share one request. Each
 * request is logged with the status and the date it returned.
 */
export class LastModifiedProbe {
  private readonly cache: TtlCache<Date | null>;
  private readonly pending = new Map<string, Promise<Date | null>>();

  constructor(ttlMs: number, maxEntries: number) {
    this.cache = new TtlCache(ttlMs, maxEntries);
  }

  get(key: string, url: string): Promise<Date | null> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const probe = headLastModified(url)
      .then(({ published, definitive, status }) => {
        console.log(
          `[last-modified] ${url} -> ${status} ${published?.toISOString() ?? 'no date'}`,
        );
        if (definitive) this.cache.set(key, published);
        return published;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, probe);
    return probe;
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}

/**
 * HEAD a URL and read its `Last-Modified` header.
 *
 * Redirects are followed: a repository may point at where the file really lives
 * (repo.scala-sbt.org 302s to Central or to Artifactory), and that file's
 * timestamp is the one that matters.
 */
async function headLastModified(url: string): Promise<{
  published: Date | null;
  definitive: boolean;
  status: number | 'error';
}> {
  let res;
  try {
    res = await axios.head(url, {
      validateStatus: () => true,
      maxRedirects: MAX_REDIRECTS,
      timeout: TIMEOUT_MS,
    });
  } catch {
    return { published: null, definitive: false, status: 'error' };
  }
  const { status } = res;
  if (status === 404 || status === 410) {
    return { published: null, definitive: true, status };
  }
  if (status !== 200) return { published: null, definitive: false, status };
  return {
    published: parseHttpDate(res.headers['last-modified']),
    definitive: true,
    status,
  };
}

/** Parse an HTTP date header, or null when it is absent or unreadable. */
export function parseHttpDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
