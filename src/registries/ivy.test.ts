import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { IvyRegistryProxy, __resetIvyCachesForTesting } from "./ivy.ts";
import { __resetCachesForTesting } from "./base.ts";
import { makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn(), head: vi.fn() },
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

import axios from "axios";

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2024-01-15T00:00:00Z");
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);


const UPSTREAM = "https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases";
const MODULE = "/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0";
const ENDPOINT = {
  apiBase: "https://scala.jfrog.io/artifactory",
  repo: "sbt-plugin-releases",
  prefix: "",
};

/** `Last-Modified` for a revision, keyed by the ivy.xml URL the proxy HEADs. */
function mockRevisionDates(dates: Record<string, string>) {
  vi.mocked(axios.head).mockImplementation(async (url: string) => {
    const date = Object.entries(dates).find(([rev]) =>
      url.includes(`/${rev}/ivys/ivy.xml`),
    )?.[1];
    if (!date) return { status: 404, headers: {} } as any;
    return {
      status: 200,
      headers: { "last-modified": new Date(date).toUTCString() },
    } as any;
  });
}

function mockFolderInfo(revisions: string[] | null) {
  vi.mocked(axios.get).mockResolvedValue(
    revisions === null
      ? ({ status: 404, data: {}, headers: {} } as any)
      : ({
          status: 200,
          headers: {},
          data: {
            children: revisions.map((r) => ({ uri: `/${r}`, folder: true })),
          },
        } as any),
  );
}

/** Answer the storage API per path: `{ "<storage path suffix>": children }`. */
function mockTree(tree: Record<string, string[]>) {
  vi.mocked(axios.get).mockImplementation(async (url: string) => {
    const entry = Object.entries(tree).find(([suffix]) =>
      url.endsWith(`/api/storage/sbt-plugin-releases${suffix}`),
    );
    if (!entry) return { status: 404, data: {}, headers: {} } as any;
    return {
      status: 200,
      headers: {},
      data: { children: entry[1].map((c) => ({ uri: `/${c}`, folder: true })) },
    } as any;
  });
}

function listingEntries(res: ReturnType<typeof makeRes>): string[] {
  const html = vi.mocked(res.send).mock.calls[0]?.[0] as string;
  return [...html.matchAll(/<a href="([^"]+)\/">/g)]
    .map((m) => m[1]!)
    .filter((e) => e !== "..");
}

let proxy: IvyRegistryProxy;

beforeEach(() => {
  vi.resetAllMocks();
  __resetIvyCachesForTesting();
  __resetCachesForTesting();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockReadFileSync.mockReturnValue(JSON.stringify({}));
  proxy = new IvyRegistryProxy({
    name: "sbt-plugins",
    upstream: UPSTREAM,
    delayMs: DELAY_MS,
    maliciousDbPath: "/dev/null",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IvyRegistryProxy – mounting", () => {
  it("uses the configured name", () => {
    expect(proxy.name).toBe("sbt-plugins");
  });

  it("falls back to 'ivy' without a name", () => {
    expect(
      new IvyRegistryProxy({
        upstream: UPSTREAM,
        delayMs: DELAY_MS,
        maliciousDbPath: "/dev/null",
      }).name,
    ).toBe("ivy");
  });
});

describe("IvyRegistryProxy – downloads", () => {
  it("HEADs the revision's ivy.xml", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString() },
    } as any);

    await proxy.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      makeRes() as any,
    );

    expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(
      `${UPSTREAM}${MODULE}/1.0.0/ivys/ivy.xml`,
    );
  });

  it("allows a revision older than the cutoff", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString() },
    } as any);

    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      res as any,
    );

    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it("blocks a revision newer than the cutoff", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-02-01T00:00:00Z").toUTCString() },
    } as any);

    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`${MODULE}/2.0.0/jars/sbt-bloop.jar`) as any,
      res as any,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks when ivy.xml cannot be read", async () => {
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);

    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      res as any,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("gates a module without cross-version segments", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString() },
    } as any);

    await proxy.handleRequest(
      makeReq("/org.scala-sbt/sbt/1.10.7/ivys/ivy.xml") as any,
      makeRes() as any,
    );

    expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(
      `${UPSTREAM}/org.scala-sbt/sbt/1.10.7/ivys/ivy.xml`,
    );
  });
});

describe("IvyRegistryProxy – revision listings", () => {
  function withIndex() {
    return new IvyRegistryProxy({
      name: "sbt-plugins",
      upstream: UPSTREAM,
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
      endpoint: ENDPOINT,
    });
  }

  it("passes the listing through when no index is configured", async () => {
    const res = makeRes();
    await proxy.handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(res.redirect).toHaveBeenCalledWith(307, `${UPSTREAM}${MODULE}/`);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("lists only the revisions past the cooldown", async () => {
    mockFolderInfo(["1.0.0", "2.0.0", "3.0.0"]);
    mockRevisionDates({
      "1.0.0": "2024-01-01T00:00:00Z",
      "2.0.0": "2024-02-01T00:00:00Z",
      "3.0.0": "2024-01-10T00:00:00Z",
    });

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(listingEntries(res)).toEqual(["1.0.0", "3.0.0"]);
  });

  it("keeps the upstream's order regardless of probe completion order", async () => {
    const revisions = Array.from({ length: 20 }, (_, i) => `1.0.${i}`);
    mockFolderInfo(revisions);
    mockRevisionDates(
      Object.fromEntries(revisions.map((r) => [r, "2024-01-01T00:00:00Z"])),
    );

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(listingEntries(res)).toEqual(revisions);
  });

  it("omits a revision whose ivy.xml has no usable timestamp", async () => {
    mockFolderInfo(["1.0.0", "2.0.0"]);
    mockRevisionDates({ "1.0.0": "2024-01-01T00:00:00Z" });

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(listingEntries(res)).toEqual(["1.0.0"]);
  });

  it("omits a revision the malicious DB names", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        maven: {
          maliciousPackages: [],
          maliciousVersions: { "ch.epfl.scala:sbt-bloop": ["2.0.0"] },
        },
      }),
    );
    mockFolderInfo(["1.0.0", "2.0.0"]);
    mockRevisionDates({
      "1.0.0": "2024-01-01T00:00:00Z",
      "2.0.0": "2024-01-01T00:00:00Z",
    });

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(listingEntries(res)).toEqual(["1.0.0"]);
  });

  it("refuses rather than serve an unfiltered listing when the API cannot be read", async () => {
    mockFolderInfo(null);

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("leaves an artifact-type directory to the passthrough", async () => {
    const res = makeRes();
    await withIndex().handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/`) as any,
      res as any,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      307,
      `${UPSTREAM}${MODULE}/1.0.0/jars/`,
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("offers only revisions a download of them would also pass", async () => {
    mockFolderInfo(["1.0.0", "2.0.0"]);
    mockRevisionDates({
      "1.0.0": "2024-01-01T00:00:00Z",
      "2.0.0": "2024-02-01T00:00:00Z",
    });
    const indexed = withIndex();

    const listing = makeRes();
    await indexed.handleRequest(makeReq(`${MODULE}/`) as any, listing as any);
    expect(listingEntries(listing)).toEqual(["1.0.0"]);

    const allowed = makeRes();
    await indexed.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      allowed as any,
    );
    expect(allowed.status).not.toHaveBeenCalledWith(404);

    const blocked = makeRes();
    await indexed.handleRequest(
      makeReq(`${MODULE}/2.0.0/jars/sbt-bloop.jar`) as any,
      blocked as any,
    );
    expect(blocked.status).toHaveBeenCalledWith(404);
  });
});

describe("IvyRegistryProxy – directories that are not revision listings", () => {
  function withIndex() {
    return new IvyRegistryProxy({
      name: "sbt-plugins",
      upstream: UPSTREAM,
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
      endpoint: ENDPOINT,
    });
  }

  it("passes a cross-version directory through instead of emptying it", async () => {
    // /ch.epfl.scala/sbt-bloop/ holds scala_2.10 and scala_2.12, not revisions.
    // Filtering it as if they were would hide the whole module.
    mockTree({
      "/ch.epfl.scala/sbt-bloop": ["scala_2.10", "scala_2.12"],
      "/ch.epfl.scala/sbt-bloop/scala_2.10": ["sbt_1.0"],
      "/ch.epfl.scala/sbt-bloop/scala_2.12": ["sbt_1.0"],
    });
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);

    const res = makeRes();
    await withIndex().handleRequest(
      makeReq("/ch.epfl.scala/sbt-bloop/") as any,
      res as any,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      307,
      `${UPSTREAM}/ch.epfl.scala/sbt-bloop/`,
    );
    expect(res.send).not.toHaveBeenCalled();
  });

  it("passes a revision's own directory through", async () => {
    mockTree({
      [`${MODULE}/1.0.0`]: ["ivys", "jars"],
      [`${MODULE}/1.0.0/ivys`]: [],
      [`${MODULE}/1.0.0/jars`]: [],
    });
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);

    const res = makeRes();
    await withIndex().handleRequest(
      makeReq(`${MODULE}/1.0.0/`) as any,
      res as any,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      307,
      `${UPSTREAM}${MODULE}/1.0.0/`,
    );
  });

  it("refuses when the children are revisions whose ivy.xml cannot be read", async () => {
    mockTree({
      [MODULE]: ["1.0.0", "2.0.0"],
      [`${MODULE}/1.0.0`]: ["ivys", "jars"],
      [`${MODULE}/2.0.0`]: ["ivys", "jars"],
    });
    vi.mocked(axios.head).mockResolvedValue({ status: 500, headers: {} } as any);

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it("still serves an empty listing when every revision is inside the cooldown", async () => {
    // Distinct from the case above: these date fine, they are just too new, so
    // the answer is a listing with nothing in it rather than a passthrough.
    mockTree({ [MODULE]: ["2.0.0"] });
    mockRevisionDates({ "2.0.0": "2024-02-01T00:00:00Z" });

    const res = makeRes();
    await withIndex().handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(listingEntries(res)).toEqual([]);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe("IvyRegistryProxy – listing document", () => {
  it("writes revision names as the upstream does, escaped for HTML only", async () => {
    const proxyWithIndex = new IvyRegistryProxy({
      name: "sbt-plugins",
      upstream: UPSTREAM,
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
      endpoint: ENDPOINT,
    });
    mockFolderInfo(["1.0.0+1-abc", "1.0.0-a&b"]);
    mockRevisionDates({
      "1.0.0+1-abc": "2024-01-01T00:00:00Z",
      "1.0.0-a&b": "2024-01-01T00:00:00Z",
    });

    const res = makeRes();
    await proxyWithIndex.handleRequest(makeReq(`${MODULE}/`) as any, res as any);

    const html = vi.mocked(res.send).mock.calls[0]?.[0] as string;
    // Artifactory writes href="1.0.0-RC1+4-c5e24b66/" literally and Coursier
    // reads it as written, so a + must not be percent-encoded.
    expect(html).toContain('href="1.0.0+1-abc/"');
    expect(html).toContain("&amp;b/");
    expect(html).not.toContain("%2B");
  });
});
