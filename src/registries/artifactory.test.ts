import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({
  default: { get: vi.fn(), head: vi.fn() },
}));

import axios from "axios";
import { listFolders, resolveArtifactoryEndpoint } from "./artifactory.ts";

const ENDPOINT = {
  apiBase: "https://scala.jfrog.io/artifactory",
  repo: "sbt-plugin-releases",
  prefix: "",
};

/**
 * Answer the storage API only for the given `{apiBase}/api/storage/{repo}`
 * prefixes, the way a real deployment answers for exactly one split of the path.
 */
function mockApi(options: {
  storage: string[];
  version?: string | null;
  children?: string[];
}) {
  const { storage, version = "7.171.0", children = ["1.0.0"] } = options;
  vi.mocked(axios.get).mockImplementation(async (url: string) => {
    if (url.includes("/api/system/version")) {
      return version === null
        ? ({ status: 404, data: {}, headers: {} } as any)
        : ({ status: 200, data: { version }, headers: {} } as any);
    }
    if (storage.some((s) => url.startsWith(s))) {
      return {
        status: 200,
        headers: {},
        data: { children: children.map((c) => ({ uri: `/${c}`, folder: true })) },
      } as any;
    }
    return { status: 404, data: {}, headers: {} } as any;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(axios.head).mockResolvedValue({ status: 200, headers: {} } as any);
});

describe("resolveArtifactoryEndpoint", () => {
  it("finds the split the API actually answers on, not the one the URL suggests", async () => {
    mockApi({
      storage: [
        "https://scala.jfrog.io/artifactory/api/storage/sbt-plugin-releases",
      ],
    });

    expect(
      await resolveArtifactoryEndpoint(
        "https://scala.jfrog.io/artifactory/sbt-plugin-releases",
      ),
    ).toEqual({ endpoint: ENDPOINT, version: "7.171.0" });
  });

  it("works for a deployment served at the host root, with no /artifactory", async () => {
    mockApi({ storage: ["https://repo.example.com/api/storage/ivy-releases"] });

    expect(
      await resolveArtifactoryEndpoint("https://repo.example.com/ivy-releases"),
    ).toEqual({
      endpoint: {
        apiBase: "https://repo.example.com",
        repo: "ivy-releases",
        prefix: "",
      },
      version: "7.171.0",
    });
  });

  it("works for a deployment under some other context path", async () => {
    mockApi({
      storage: ["https://nexus.example.com/repo/jfrog/api/storage/ivy"],
    });

    expect(
      await resolveArtifactoryEndpoint(
        "https://nexus.example.com/repo/jfrog/ivy",
      ),
    ).toEqual({
      endpoint: {
        apiBase: "https://nexus.example.com/repo/jfrog",
        repo: "ivy",
        prefix: "",
      },
      version: "7.171.0",
    });
  });

  it("keeps a path below the repository as a prefix", async () => {
    mockApi({
      storage: ["https://example.com/artifactory/api/storage/repo/sub/dir"],
    });

    expect(
      await resolveArtifactoryEndpoint(
        "https://example.com/artifactory/repo/sub/dir/",
      ),
    ).toEqual({
      endpoint: {
        apiBase: "https://example.com/artifactory",
        repo: "repo",
        prefix: "/sub/dir",
      },
      version: "7.171.0",
    });
  });

  it("follows a redirect to the deployment that answers", async () => {
    vi.mocked(axios.head).mockResolvedValueOnce({
      status: 302,
      headers: {
        location: "https://scala.jfrog.io/artifactory/sbt-plugin-releases/",
      },
    } as any);
    vi.mocked(axios.head).mockResolvedValue({ status: 200, headers: {} } as any);
    mockApi({
      storage: [
        "https://scala.jfrog.io/artifactory/api/storage/sbt-plugin-releases",
      ],
    });

    expect(
      await resolveArtifactoryEndpoint(
        "https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases",
      ),
    ).toEqual({ endpoint: ENDPOINT, version: "7.171.0" });
  });

  it("reports every split it tried when nothing answers", async () => {
    mockApi({ storage: [] });

    const result = await resolveArtifactoryEndpoint("https://repo.clojars.org/x");
    expect(result).toMatchObject({
      error: expect.stringContaining("https://repo.clojars.org/api/storage/x"),
    });
  });

  it("reports a deployment whose storage API answers but version does not", async () => {
    mockApi({
      storage: ["https://example.com/artifactory/api/storage/repo"],
      version: null,
    });

    expect(
      await resolveArtifactoryEndpoint("https://example.com/artifactory/repo"),
    ).toMatchObject({
      error: expect.stringContaining("/api/system/version"),
    });
  });

  it("rejects a URL that names no repository", async () => {
    expect(
      await resolveArtifactoryEndpoint("https://repo.example.com"),
    ).toMatchObject({ error: expect.stringContaining("no path") });
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe("listFolders", () => {
  it("returns child folder names without their leading slash", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        children: [
          { uri: "/1.0.0", folder: true },
          { uri: "/ivy.xml", folder: false },
          { uri: "/2.0.0", folder: true },
        ],
      },
    } as any);

    expect(await listFolders(ENDPOINT, "/org/mod")).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
    expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toBe(
      "https://scala.jfrog.io/artifactory/api/storage/sbt-plugin-releases/org/mod",
    );
  });

  it("returns null rather than an empty list when the API does not answer", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 403,
      data: {},
      headers: {},
    } as any);

    expect(await listFolders(ENDPOINT, "/org/mod")).toBe(null);
  });
});
