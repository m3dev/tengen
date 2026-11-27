import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MavenRegistryProxy, __resetProbeCacheForTesting } from "./maven.ts";
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
const AT_CUTOFF = CUTOFF.getTime();
const AFTER_CUTOFF = new Date("2024-02-01T00:00:00Z").getTime();

type DepsDevVersionEntry = { versionKey: { version: string }; publishedAt: string };

let proxy: MavenRegistryProxy;

beforeEach(() => {
  vi.resetAllMocks();
  __resetProbeCacheForTesting();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  proxy = new MavenRegistryProxy({
    upstream: "https://repo1.maven.org/maven2",
    delayMs: DELAY_MS,
    maliciousDbPath: "/dev/null",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeXml(versions: string[], release = "", latest = ""): string {
  const versionTags = versions
    .map((v) => `    <version>${v}</version>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.example</groupId>
  <artifactId>mylib</artifactId>
  <versioning>
    <latest>${latest || versions[versions.length - 1] || ""}</latest>
    <release>${release || versions[versions.length - 1] || ""}</release>
    <versions>
${versionTags}
    </versions>
    <lastUpdated>20240201000000</lastUpdated>
  </versioning>
</metadata>`;
}

// Maven makes two sequential axios.get calls for metadata paths:
//   1. upstream maven-metadata.xml
//   2. deps.dev package API for version timestamps
async function handle(
  path: string,
  xml: string,
  versions: DepsDevVersionEntry[] = [],
  upstreamStatus = 200,
): Promise<ReturnType<typeof makeRes>> {
  vi.mocked(axios.get)
    .mockResolvedValueOnce({ status: upstreamStatus, data: xml, headers: {} })
    .mockResolvedValueOnce({
      status: 200,
      data: { versions },
      headers: {},
    });
  const res = makeRes();
  await proxy.handleRequest(makeReq(path), res);
  return res;
}

describe("MavenRegistryProxy – routing", () => {
  it("redirects paths with fewer than 4 segments (not download/metadata) as passthrough", async () => {
    const res = makeRes();
    await proxy.handleRequest(makeReq("/archetype-catalog.xml"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      "https://repo1.maven.org/maven2/archetype-catalog.xml",
    );
  });

  it("constructs correct packageName for deeply nested groupId", async () => {
    const xml = makeXml(["1.0.0"]);
    await handle("/org/springframework/boot/spring-boot/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
    ]);
    expect(vi.mocked(axios.get)).toHaveBeenCalledWith(
      "https://api.deps.dev/v3alpha/systems/maven/packages/org.springframework.boot:spring-boot",
      expect.any(Object),
    );
  });

  it("responds to maven-metadata.xml with XML content-type (not streamed)", async () => {
    const xml = makeXml(["1.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
    ]);
    expect(res.type).toHaveBeenCalledWith("application/xml");
    expect(res.send).toHaveBeenCalled();
  });
});

describe("MavenRegistryProxy – download routing", () => {
  it("redirects JARs for allowed versions", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.jar"),
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      "https://repo1.maven.org/maven2/com/example/mylib/1.0.0/mylib-1.0.0.jar",
    );
  });

  it("blocks JARs for versions published after the cutoff", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/2.0.0/mylib-2.0.0.jar"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks JARs when neither deps.dev nor the upstream has a date", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 404,
      data: {},
      headers: {},
    });
    vi.mocked(axios.head).mockResolvedValueOnce({ status: 404, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.jar"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("also checks POMs and sources JARs", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { versionKey: { version: "1.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.pom"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("MavenRegistryProxy – metadata filtering", () => {
  it("removes versions published after the cutoff", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }, // allowed
      { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() }, // filtered
    ]);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
    expect(body).not.toContain("<version>2.0.0</version>");
  });

  it("includes versions published exactly at the cutoff", async () => {
    const xml = makeXml(["1.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(AT_CUTOFF).toISOString() },
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
  });

  it("updates <release>, <latest>, and <lastUpdated> to the latest allowed version", async () => {
    const xml = makeXml(["1.0.0", "1.1.0", "2.0.0"], "2.0.0", "2.0.0");
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
      { versionKey: { version: "1.1.0" }, publishedAt: new Date(BEFORE_CUTOFF + 1000).toISOString() }, // newest allowed
      { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
    ]);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<release>1.1.0</release>");
    expect(body).toContain("<latest>1.1.0</latest>");
    // 1.1.0 published at 2024-01-01T00:00:01Z → Maven yyyyMMddHHmmss (UTC)
    expect(body).toContain("<lastUpdated>20240101000001</lastUpdated>");
    expect(body).not.toContain("<lastUpdated>20240201000000</lastUpdated>");
  });

  it("returns 404 when all versions are filtered out", async () => {
    const xml = makeXml(["2.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
    ]);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("proxies upstream non-200 status without calling the search API", async () => {
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml",
      "",
      [],
      404,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(1);
  });

  it("passes through group-level metadata (no <versions> block) without calling the search API", async () => {
    const groupXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <plugins><plugin><name>MyPlugin</name></plugin></plugins>
</metadata>`;
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: groupXml,
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/com/example/maven-metadata.xml"), res);
    expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(groupXml);
  });
});

describe("MavenRegistryProxy – checksum endpoints", () => {
  // The proxy rewrites <lastUpdated> to the latest allowed version's publish
  // timestamp, so the checksum is computed over that filtered XML, not the raw upstream.
  function withRolledBackLastUpdated(xml: string): string {
    return xml.replace(
      "<lastUpdated>20240201000000</lastUpdated>",
      "<lastUpdated>20240101000000</lastUpdated>",
    );
  }

  it("returns SHA1 of the filtered XML for .sha1 path", async () => {
    const xml = makeXml(["1.0.0"]);
    const expected = createHash("sha1")
      .update(withRolledBackLastUpdated(xml))
      .digest("hex");
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml.sha1",
      xml,
      [{ versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(expected);
  });

  it("returns MD5 of the filtered XML for .md5 path", async () => {
    const xml = makeXml(["1.0.0"]);
    const expected = createHash("md5")
      .update(withRolledBackLastUpdated(xml))
      .digest("hex");
    const res = await handle("/com/example/mylib/maven-metadata.xml.md5", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(expected);
  });

  it("returns 404 for .sha1 when all versions are filtered out", async () => {
    const xml = makeXml(["2.0.0"]);
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml.sha1",
      xml,
      [{ versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() }],
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("MavenRegistryProxy – malicious filtering", () => {
  // Maven OSV package name format: "groupId:artifactId"
  // /com/example/evil/maven-metadata.xml → "com.example:evil"
  // /com/example/mylib/maven-metadata.xml → "com.example:mylib"
  const MALICIOUS_DB = JSON.stringify({
    maven: { maliciousPackages: ["com.example:evil"], maliciousVersions: { "com.example:mylib": ["1.0.0"] } },
  });

  let maliciousProxy: MavenRegistryProxy;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new MavenRegistryProxy({
      upstream: "https://repo1.maven.org/maven2",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
    });
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it("returns 404 when the artifact is fully malicious", async () => {
    const xml = makeXml(["1.0.0"]);
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: xml, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { versions: [{ versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }] },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/com/example/evil/maven-metadata.xml"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks a specific malicious version while keeping safe ones", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: xml, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          versions: [
            { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }, // malicious → blocked
            { versionKey: { version: "2.0.0" }, publishedAt: new Date(BEFORE_CUTOFF + 1000).toISOString() }, // safe → allowed
          ],
        },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/com/example/mylib/maven-metadata.xml"),
      res,
    );
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).not.toContain("<version>1.0.0</version>");
    expect(body).toContain("<version>2.0.0</version>");
  });
});

describe("MavenRegistryProxy – deps.dev with Last-Modified fallback", () => {
  const POM = (v: string) =>
    `https://repo1.maven.org/maven2/com/example/mylib/${v}/mylib-${v}.pom`;
  const depsDevMissing = { status: 404, data: {}, headers: {} };

  beforeEach(() => {
    __resetCachesForTesting();
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
  });

  /**
   * deps.dev answers `depsDev`, the upstream serves `xml`, and each POM's
   * Last-Modified comes from `pomDates` (null: header absent). A version missing
   * from `pomDates` is a 404.
   */
  function mockRepos(opts: {
    depsDev: { status: number; data: unknown; headers: object };
    xml?: string;
    pomDates?: Record<string, number | null>;
  }) {
    vi.mocked(axios.get).mockImplementation(((url: string) =>
      Promise.resolve(
        url.startsWith("https://api.deps.dev/")
          ? opts.depsDev
          : { status: 200, data: opts.xml, headers: {} },
      )) as any);
    vi.mocked(axios.head).mockImplementation(((url: string) => {
      const version = Object.keys(opts.pomDates ?? {}).find((v) =>
        url.includes(`/${v}/`),
      );
      if (version === undefined) {
        return Promise.resolve({ status: 404, headers: {} });
      }
      const date = opts.pomDates![version];
      return Promise.resolve({
        status: 200,
        headers:
          date == null ? {} : { "last-modified": new Date(date).toUTCString() },
      });
    }) as any);
  }

  const depsDevVersion = (version: string, publishedAt: number) => ({
    status: 200,
    data: {
      versionKey: { version },
      publishedAt: new Date(publishedAt).toISOString(),
    },
    headers: {},
  });

  const depsDevPackage = (versions: DepsDevVersionEntry[]) => ({
    status: 200,
    data: { versions },
    headers: {},
  });

  async function download(version: string) {
    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`/com/example/mylib/${version}/mylib-${version}.jar`),
      res,
    );
    return res;
  }

  async function metadata() {
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/maven-metadata.xml"),
      res,
    );
    return String(vi.mocked(res.send).mock.calls[0]?.[0]);
  }

  describe("downloads", () => {
    it("dates the version by its POM when deps.dev has no record", async () => {
      mockRepos({
        depsDev: depsDevMissing,
        pomDates: { "1.0.0": BEFORE_CUTOFF },
      });
      const res = await download("1.0.0");
      expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(POM("1.0.0"));
      expect(res.redirect).toHaveBeenCalledWith(
        307,
        "https://repo1.maven.org/maven2/com/example/mylib/1.0.0/mylib-1.0.0.jar",
      );
    });

    it("blocks a version whose POM is newer than the cutoff", async () => {
      mockRepos({
        depsDev: depsDevMissing,
        pomDates: { "2.0.0": AFTER_CUTOFF },
      });
      const res = await download("2.0.0");
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("blocks a version whose POM has no Last-Modified", async () => {
      mockRepos({ depsDev: depsDevMissing, pomDates: { "1.0.0": null } });
      const res = await download("1.0.0");
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("falls back when deps.dev answers without a publishedAt", async () => {
      mockRepos({
        depsDev: {
          status: 200,
          data: { versionKey: { version: "1.0.0" } },
          headers: {},
        },
        pomDates: { "1.0.0": BEFORE_CUTOFF },
      });
      const res = await download("1.0.0");
      expect(res.redirect).toHaveBeenCalled();
    });

    it("falls back when deps.dev is down", async () => {
      mockRepos({
        depsDev: { status: 503, data: "", headers: {} },
        pomDates: { "1.0.0": BEFORE_CUTOFF },
      });
      const res = await download("1.0.0");
      expect(res.redirect).toHaveBeenCalled();
    });

    it("does not probe when deps.dev has the date", async () => {
      mockRepos({
        depsDev: depsDevVersion("1.0.0", BEFORE_CUTOFF),
        pomDates: { "1.0.0": BEFORE_CUTOFF },
      });
      const res = await download("1.0.0");
      expect(res.redirect).toHaveBeenCalled();
      expect(vi.mocked(axios.head)).not.toHaveBeenCalled();
    });

    it("never lets Last-Modified override a date from deps.dev", async () => {
      mockRepos({
        depsDev: depsDevVersion("2.0.0", AFTER_CUTOFF),
        pomDates: { "2.0.0": BEFORE_CUTOFF },
      });
      const res = await download("2.0.0");
      expect(res.status).toHaveBeenCalledWith(404);
      expect(vi.mocked(axios.head)).not.toHaveBeenCalled();
    });
  });

  describe("metadata", () => {
    it("probes every listed version when deps.dev does not know the package", async () => {
      const xml = makeXml(["1.0.0", "1.1.0", "2.0.0"]);
      mockRepos({
        depsDev: depsDevMissing,
        xml,
        pomDates: {
          "1.0.0": BEFORE_CUTOFF,
          "1.1.0": BEFORE_CUTOFF,
          "2.0.0": AFTER_CUTOFF,
        },
      });
      const out = await metadata();
      expect(out).toContain("<version>1.0.0</version>");
      expect(out).toContain("<version>1.1.0</version>");
      expect(out).not.toContain("<version>2.0.0</version>");
      expect(out).toContain("<latest>1.1.0</latest>");
    });

    it("probes only the versions deps.dev has no date for", async () => {
      const xml = makeXml(["1.0.0", "1.1.0"]);
      mockRepos({
        depsDev: depsDevPackage([
          {
            versionKey: { version: "1.0.0" },
            publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
          },
        ]),
        xml,
        pomDates: { "1.1.0": BEFORE_CUTOFF },
      });
      const out = await metadata();
      expect(out).toContain("<version>1.0.0</version>");
      expect(out).toContain("<version>1.1.0</version>");
      expect(vi.mocked(axios.head)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(POM("1.1.0"));
    });

    it("does not probe when deps.dev dates every listed version", async () => {
      const xml = makeXml(["1.0.0", "1.1.0"]);
      mockRepos({
        depsDev: depsDevPackage(
          ["1.0.0", "1.1.0"].map((version) => ({
            versionKey: { version },
            publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
          })),
        ),
        xml,
      });
      await metadata();
      expect(vi.mocked(axios.head)).not.toHaveBeenCalled();
    });

    it("probes a version deps.dev lists without a publishedAt", async () => {
      const xml = makeXml(["1.0.0"]);
      mockRepos({
        depsDev: depsDevPackage([
          { versionKey: { version: "1.0.0" } } as DepsDevVersionEntry,
        ]),
        xml,
        pomDates: { "1.0.0": BEFORE_CUTOFF },
      });
      const out = await metadata();
      expect(out).toContain("<version>1.0.0</version>");
    });

    it("falls back when deps.dev is down", async () => {
      const xml = makeXml(["1.0.0", "2.0.0"]);
      mockRepos({
        depsDev: { status: 503, data: "", headers: {} },
        xml,
        pomDates: { "1.0.0": BEFORE_CUTOFF, "2.0.0": AFTER_CUTOFF },
      });
      const out = await metadata();
      expect(out).toContain("<version>1.0.0</version>");
      expect(out).not.toContain("<version>2.0.0</version>");
    });

    it("keeps blocking a version neither source can date", async () => {
      const xml = makeXml(["1.0.0", "1.1.0"]);
      mockRepos({
        depsDev: depsDevMissing,
        xml,
        pomDates: { "1.0.0": BEFORE_CUTOFF, "1.1.0": null },
      });
      const out = await metadata();
      expect(out).toContain("<version>1.0.0</version>");
      expect(out).not.toContain("<version>1.1.0</version>");
    });

    it("returns 404 when no version can be dated", async () => {
      const xml = makeXml(["1.0.0"]);
      mockRepos({ depsDev: depsDevMissing, xml, pomDates: { "1.0.0": null } });
      const res = makeRes();
      await proxy.handleRequest(
        makeReq("/com/example/mylib/maven-metadata.xml"),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});

describe("MavenRegistryProxy – sbt plugins whose files omit the cross-version suffix", () => {
  const depsDevMissing = { status: 404, data: {}, headers: {} };
  const POM = (dir: string, name: string) =>
    `https://repo1.maven.org/maven2/org/example/${dir}/3.0.0/${name}-3.0.0.pom`;

  beforeEach(() => {
    __resetCachesForTesting();
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
  });

  /**
   * deps.dev knows nothing, and the upstream has only the POMs in `poms`
   * (file name → Last-Modified). Any other file is a 404.
   */
  function mockUpstream(poms: Record<string, number>, xml?: string) {
    vi.mocked(axios.get).mockImplementation(((url: string) =>
      Promise.resolve(
        url.startsWith("https://api.deps.dev/")
          ? depsDevMissing
          : { status: 200, data: xml, headers: {} },
      )) as any);
    vi.mocked(axios.head).mockImplementation(((url: string) => {
      const name = url.slice(url.lastIndexOf("/") + 1);
      return Promise.resolve(
        name in poms
          ? {
              status: 200,
              headers: { "last-modified": new Date(poms[name]!).toUTCString() },
            }
          : { status: 404, headers: {} },
      );
    }) as any);
  }

  const probed = () => vi.mocked(axios.head).mock.calls.map((c) => c[0]);

  async function download(dir: string, file: string) {
    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`/org/example/${dir}/3.0.0/${file}`),
      res,
    );
    return res;
  }

  it("dates the plugin by the POM without the suffix when the suffixed one is missing", async () => {
    mockUpstream({ "sbt-demo-plugin-3.0.0.pom": BEFORE_CUTOFF });
    const res = await download(
      "sbt-demo-plugin_2.12_1.0",
      "sbt-demo-plugin-3.0.0.jar",
    );
    expect(probed()).toEqual([
      POM("sbt-demo-plugin_2.12_1.0", "sbt-demo-plugin_2.12_1.0"),
      POM("sbt-demo-plugin_2.12_1.0", "sbt-demo-plugin"),
    ]);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      "https://repo1.maven.org/maven2/org/example/sbt-demo-plugin_2.12_1.0/3.0.0/sbt-demo-plugin-3.0.0.jar",
    );
  });

  it("handles the sbt 0.13 suffix", async () => {
    mockUpstream({ "sbt-demo-plugin-3.0.0.pom": BEFORE_CUTOFF });
    const res = await download(
      "sbt-demo-plugin_2.10_0.13",
      "sbt-demo-plugin-3.0.0.jar",
    );
    expect(res.redirect).toHaveBeenCalled();
  });

  it("keeps the POM named after the directory when it exists", async () => {
    mockUpstream({
      "sbt-demo-plugin_2.12_1.0-3.0.0.pom": BEFORE_CUTOFF,
      "sbt-demo-plugin-3.0.0.pom": AFTER_CUTOFF,
    });
    const res = await download(
      "sbt-demo-plugin_2.12_1.0",
      "sbt-demo-plugin_2.12_1.0-3.0.0.jar",
    );
    expect(res.redirect).toHaveBeenCalled();
    expect(probed()).toHaveLength(1);
  });

  it("blocks the plugin when the POM without the suffix is inside the cooldown", async () => {
    mockUpstream({ "sbt-demo-plugin-3.0.0.pom": AFTER_CUTOFF });
    const res = await download(
      "sbt-demo-plugin_2.12_1.0",
      "sbt-demo-plugin-3.0.0.jar",
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks the plugin when neither POM exists", async () => {
    mockUpstream({});
    const res = await download(
      "sbt-demo-plugin_2.12_1.0",
      "sbt-demo-plugin-3.0.0.jar",
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("tries no other name for an artifact without a suffix", async () => {
    mockUpstream({});
    const res = await download("mylib", "mylib-3.0.0.jar");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(probed()).toEqual([POM("mylib", "mylib")]);
  });

  it("lists a version dated by the POM without the suffix", async () => {
    mockUpstream(
      { "sbt-demo-plugin-3.0.0.pom": BEFORE_CUTOFF },
      makeXml(["3.0.0"]),
    );
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/org/example/sbt-demo-plugin_2.12_1.0/maven-metadata.xml"),
      res,
    );
    expect(String(vi.mocked(res.send).mock.calls[0]?.[0])).toContain(
      "<version>3.0.0</version>",
    );
  });
});
