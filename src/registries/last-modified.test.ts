import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { LastModifiedProbe } from "./last-modified.ts";

vi.mock("axios", () => ({
  default: { head: vi.fn() },
}));

const OLD = new Date("2024-01-01T00:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
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
