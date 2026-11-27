import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { LastModifiedProbe } from "./last-modified.ts";

vi.mock("axios", () => ({
  default: { head: vi.fn() },
}));

const OLD = new Date("2024-01-01T00:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("LastModifiedProbe", () => {
  it("reads Last-Modified and caches it", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": OLD.toUTCString() },
    } as any);
    const probe = new LastModifiedProbe(60_000, 10);

    expect(await probe.get("k", "https://a.example.com/x")).toEqual(OLD);
    expect(await probe.get("k", "https://a.example.com/x")).toEqual(OLD);
    expect(axios.head).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent probes of the same key", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": OLD.toUTCString() },
    } as any);
    const probe = new LastModifiedProbe(60_000, 10);

    await Promise.all([
      probe.get("k", "https://a.example.com/x"),
      probe.get("k", "https://a.example.com/x"),
    ]);
    expect(axios.head).toHaveBeenCalledTimes(1);
  });

  it("caches a 404 as unknown", async () => {
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);
    const probe = new LastModifiedProbe(60_000, 10);

    expect(await probe.get("k", "https://a.example.com/x")).toBeNull();
    expect(await probe.get("k", "https://a.example.com/x")).toBeNull();
    expect(axios.head).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 429", () => Promise.resolve({ status: 429, headers: {} })],
    ["a 503", () => Promise.resolve({ status: 503, headers: {} })],
    ["a network error", () => Promise.reject(new Error("ECONNRESET"))],
  ])("returns null without caching on %s", async (_, response) => {
    vi.mocked(axios.head).mockImplementation(response as any);
    const probe = new LastModifiedProbe(60_000, 10);

    expect(await probe.get("k", "https://a.example.com/x")).toBeNull();
    expect(await probe.get("k", "https://a.example.com/x")).toBeNull();
    expect(axios.head).toHaveBeenCalledTimes(2);
  });

  it("sets a timeout on the request", async () => {
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);
    await new LastModifiedProbe(60_000, 10).get("k", "https://a.example.com/x");

    expect(vi.mocked(axios.head).mock.calls[0]?.[1]).toMatchObject({
      timeout: expect.any(Number),
    });
  });
});

describe("LastModifiedProbe logging", () => {
  const URL = "https://a.example.com/x";
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
  });

  it("logs the date it read", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": OLD.toUTCString() },
    } as any);
    await new LastModifiedProbe(60_000, 10).get("k", URL);

    expect(log).toHaveBeenCalledWith(
      `[last-modified] ${URL} -> 200 ${OLD.toISOString()}`,
    );
  });

  it("logs an answer without a date", async () => {
    vi.mocked(axios.head).mockResolvedValue({ status: 200, headers: {} } as any);
    await new LastModifiedProbe(60_000, 10).get("k", URL);

    expect(log).toHaveBeenCalledWith(`[last-modified] ${URL} -> 200 no date`);
  });

  it("logs a missing file", async () => {
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);
    await new LastModifiedProbe(60_000, 10).get("k", URL);

    expect(log).toHaveBeenCalledWith(`[last-modified] ${URL} -> 404 no date`);
  });

  it("logs a failed request", async () => {
    vi.mocked(axios.head).mockRejectedValue(new Error("ECONNRESET"));
    await new LastModifiedProbe(60_000, 10).get("k", URL);

    expect(log).toHaveBeenCalledWith(`[last-modified] ${URL} -> error no date`);
  });

  it("logs a probe once while its answer is cached", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": OLD.toUTCString() },
    } as any);
    const probe = new LastModifiedProbe(60_000, 10);
    await Promise.all([probe.get("k", URL), probe.get("k", URL)]);
    await probe.get("k", URL);

    expect(log).toHaveBeenCalledTimes(1);
  });
});
