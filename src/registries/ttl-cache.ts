/**
 * A map that forgets.
 *
 * Entries expire after `ttlMs`, and the oldest are dropped once `maxEntries` is
 * exceeded. Both proxies that probe upstream timestamps cache one entry per
 * artifact URL, and a long-running proxy sees an unbounded number of those, so
 * a plain Map would grow for the life of the process.
 *
 * Expiry is deliberately short. A repository can rewrite an artifact's mtime on
 * re-sync, and a stale entry would keep serving a version whose timestamp has
 * since moved forward into the cooldown window.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  // Assigned in the body rather than declared as parameter properties: tengen
  // runs under Node's type stripping, which cannot transform those.
  constructor(ttlMs: number, maxEntries: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /** The cached value, or undefined when absent or expired. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Re-inserting moves the key to the end, so iteration order stays
    // oldest-write-first and eviction can simply take from the front.
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    if (this.entries.size <= this.maxEntries) return;
    for (const oldest of this.entries.keys()) {
      this.entries.delete(oldest);
      if (this.entries.size <= this.maxEntries) return;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** @internal Number of entries held, expired ones included. Used by tests. */
  get size(): number {
    return this.entries.size;
  }
}
