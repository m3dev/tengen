import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TtlCache } from "./ttl-cache.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-15T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("returns a value until it expires", () => {
    const cache = new TtlCache<number>(1000, 10);
    cache.set("a", 1);

    expect(cache.get("a")).toBe(1);
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(cache.get("a")).toBeUndefined();
  });

  it("distinguishes a cached null from a miss", () => {
    // Both proxies cache "this URL has no usable timestamp" as null, so null
    // must not read as absent — that would re-probe on every request.
    const cache = new TtlCache<Date | null>(1000, 10);
    cache.set("a", null);

    expect(cache.get("a")).toBe(null);
    expect(cache.get("b")).toBeUndefined();
  });

  it("drops an expired entry rather than holding it", () => {
    const cache = new TtlCache<number>(1000, 10);
    cache.set("a", 1);
    vi.advanceTimersByTime(1000);

    cache.get("a");
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest writes once it is full", () => {
    const cache = new TtlCache<number>(60_000, 3);
    for (const key of ["a", "b", "c", "d"]) cache.set(key, 1);

    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe(1);
  });

  it("counts a rewrite as the newest entry", () => {
    const cache = new TtlCache<number>(60_000, 3);
    cache.set("a", 1);
    cache.set("b", 1);
    cache.set("c", 1);
    cache.set("a", 2);
    cache.set("d", 1);

    expect(cache.get("a")).toBe(2);
    expect(cache.get("b")).toBeUndefined();
  });
});
