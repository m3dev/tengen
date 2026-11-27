import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { GradlePluginsRegistryProxy } from "./gradle-plugins.ts";
import { __resetProbeCacheForTesting } from "./maven.ts";
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

const BEFORE_CUTOFF = new Date("2024-01-01T00:00:00Z").getTime();
const AFTER_CUTOFF = new Date("2024-02-01T00:00:00Z").getTime();

type DepsDevVersionEntry = {
  versionKey: { version: string };
  publishedAt: string;
};

let proxy: GradlePluginsRegistryProxy;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  __resetProbeCacheForTesting();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  proxy = new GradlePluginsRegistryProxy({
    upstream: "https://plugins.gradle.org/m2",
    delayMs: DELAY_MS,
    maliciousDbPath: "/dev/null",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeXml(versions: string[]): string {
  const versionTags = versions
    .map((v) => `    <version>${v}</version>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>org.example</groupId>
  <artifactId>my-plugin</artifactId>
  <versioning>
    <latest>${versions[versions.length - 1] || ""}</latest>
    <release>${versions[versions.length - 1] || ""}</release>
    <versions>
${versionTags}
    </versions>
    <lastUpdated>20240201000000</lastUpdated>
  </versioning>
</metadata>`;
}

// Like Maven, metadata paths trigger two sequential axios.get calls:
//   1. upstream maven-metadata.xml on the plugin portal
//   2. deps.dev package API (Maven ecosystem) for version timestamps
async function handle(
  path: string,
  xml: string,
  versions: DepsDevVersionEntry[] = [],
  upstreamStatus = 200,
): Promise<ReturnType<typeof makeRes>> {
  vi.mocked(axios.get)
    .mockResolvedValueOnce({ status: upstreamStatus, data: xml, headers: {} })
    .mockResolvedValueOnce({ status: 200, data: { versions }, headers: {} });
  const res = makeRes();
  await proxy.handleRequest(makeReq(path), res);
  return res;
}

describe("GradlePluginsRegistryProxy – identity", () => {
  it("uses 'gradle-plugins' as the registry name (URL prefix)", () => {
    expect(proxy.name).toBe("gradle-plugins");
  });
});

describe("GradlePluginsRegistryProxy – routing", () => {
  it("redirects unrecognized paths to the plugin portal upstream", async () => {
    const res = makeRes();
    await proxy.handleRequest(makeReq("/archetype-catalog.xml"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      "https://plugins.gradle.org/m2/archetype-catalog.xml",
    );
  });

  it("redirects marker-artifact downloads for allowed versions", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: {
        versionKey: { version: "1.0.0" },
        publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
      },
      headers: {},
    });
    const res = makeRes();
    const path =
      "/org/example/my-plugin/org.example.my-plugin.gradle.plugin/1.0.0/org.example.my-plugin.gradle.plugin-1.0.0.pom";
    await proxy.handleRequest(makeReq(path), res);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      `https://plugins.gradle.org/m2${path}`,
    );
  });

  it("blocks downloads for versions inside the delay window", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: {
        versionKey: { version: "2.0.0" },
        publishedAt: new Date(AFTER_CUTOFF).toISOString(),
      },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/org/example/my-plugin/2.0.0/my-plugin-2.0.0.jar"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("GradlePluginsRegistryProxy – metadata filtering", () => {
  it("removes versions published inside the delay window", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    const res = await handle(
      "/org/example/my-plugin/maven-metadata.xml",
      xml,
      [
        {
          versionKey: { version: "1.0.0" },
          publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
        },
        {
          versionKey: { version: "2.0.0" },
          publishedAt: new Date(AFTER_CUTOFF).toISOString(),
        },
      ],
    );
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
    expect(body).not.toContain("<version>2.0.0</version>");
  });
});

describe("GradlePluginsRegistryProxy – 303 metadata redirects", () => {
  it("follows a 303 and filters the resolved metadata", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    const resolvedUrl =
      "https://cdn.example.com/org/example/my-plugin/maven-metadata.xml";
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        status: 303,
        data: "",
        headers: { location: resolvedUrl },
      })
      .mockResolvedValueOnce({ status: 200, data: xml, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          versions: [
            {
              versionKey: { version: "1.0.0" },
              publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
            },
            {
              versionKey: { version: "2.0.0" },
              publishedAt: new Date(AFTER_CUTOFF).toISOString(),
            },
          ],
        },
        headers: {},
      });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/org/example/my-plugin/maven-metadata.xml"),
      res,
    );
    // followed the 303 to fetch the resolved metadata
    expect(vi.mocked(axios.get).mock.calls[1][0]).toBe(resolvedUrl);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
    expect(body).not.toContain("<version>2.0.0</version>");
  });
});

describe("GradlePluginsRegistryProxy – malicious filtering shares the maven DB", () => {
  // Entries live under the "maven" ecosystem key, since OSV tracks Gradle
  // plugin artifacts under Maven. The proxy must look them up via its
  // overridden dbKey rather than its own "gradle-plugins" name.
  const MALICIOUS_DB = JSON.stringify({
    maven: {
      maliciousPackages: ["org.example:evil-plugin"],
      maliciousVersions: { "org.example:my-plugin": ["1.0.0"] },
    },
  });

  let maliciousProxy: GradlePluginsRegistryProxy;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new GradlePluginsRegistryProxy({
      upstream: "https://plugins.gradle.org/m2",
      delayMs: DELAY_MS,
      maliciousDbPath: "/some/db.json",
    });
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it("returns 404 when the whole plugin is flagged malicious", async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: makeXml(["1.0.0"]), headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          versions: [
            {
              versionKey: { version: "1.0.0" },
              publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
            },
          ],
        },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/org/example/evil-plugin/maven-metadata.xml"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("drops a malicious version while keeping safe ones", async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        status: 200,
        data: makeXml(["1.0.0", "2.0.0"]),
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          versions: [
            {
              versionKey: { version: "1.0.0" },
              publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
            },
            {
              versionKey: { version: "2.0.0" },
              publishedAt: new Date(BEFORE_CUTOFF + 1000).toISOString(),
            },
          ],
        },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/org/example/my-plugin/maven-metadata.xml"),
      res,
    );
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).not.toContain("<version>1.0.0</version>");
    expect(body).toContain("<version>2.0.0</version>");
  });
});

describe("GradlePluginsRegistryProxy – Last-Modified fallback", () => {
  const PATH = "/org/example/my-plugin/maven-metadata.xml";
  const POM_1_0_0 =
    "https://plugins.gradle.org/m2/org/example/my-plugin/1.0.0/my-plugin-1.0.0.pom";

  beforeEach(() => {
    __resetCachesForTesting();
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
  });

  // deps.dev does not know the plugin; the portal serves its POM with a
  // Last-Modified before the cutoff.
  function mockUnknownToDepsDev() {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        status: 200,
        data: makeXml(["1.0.0"]),
        headers: {},
      })
      .mockResolvedValueOnce({ status: 404, data: {}, headers: {} });
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date(BEFORE_CUTOFF).toUTCString() },
    });
  }

  it("dates versions deps.dev lacks by their POM when enabled", async () => {
    proxy = new GradlePluginsRegistryProxy({
      upstream: "https://plugins.gradle.org/m2",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
      lastModifiedFallback: true,
    });
    mockUnknownToDepsDev();
    const res = makeRes();
    await proxy.handleRequest(makeReq(PATH), res);
    expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(POM_1_0_0);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
  });

  it("keeps such versions blocked by default", async () => {
    mockUnknownToDepsDev();
    const res = makeRes();
    await proxy.handleRequest(makeReq(PATH), res);
    expect(vi.mocked(axios.head)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
