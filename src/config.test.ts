import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults when no args are provided", () => {
    const config = loadConfig([]);
    expect(config.port).toBe(3000);
    expect(config.upstreams.npm).toBe("https://registry.npmjs.org");
    expect(config.upstreams.pypi).toBe("https://pypi.org");
    expect(config.upstreams.rubygems).toBe("https://rubygems.org");
    expect(config.upstreams.go).toBe("https://proxy.golang.org");
    expect(config.upstreams.composer).toBe("https://packagist.org");
    expect(config.upstreams.maven).toBe("https://repo.maven.apache.org/maven2");
    expect(config.delayDays).toBe(7);
  });

  it("parses --port", () => {
    const config = loadConfig(["--port", "8080"]);
    expect(config.port).toBe(8080);
  });

  it("parses -p shorthand", () => {
    const config = loadConfig(["-p", "9000"]);
    expect(config.port).toBe(9000);
  });

  it("parses --npm-upstream", () => {
    const config = loadConfig(["--npm-upstream", "https://my-npm.example.com"]);
    expect(config.upstreams.npm).toBe("https://my-npm.example.com");
  });

  it("parses --pypi-upstream", () => {
    const config = loadConfig([
      "--pypi-upstream",
      "https://my-pypi.example.com",
    ]);
    expect(config.upstreams.pypi).toBe("https://my-pypi.example.com");
  });

  it("parses --rubygems-upstream", () => {
    const config = loadConfig([
      "--rubygems-upstream",
      "https://my-gems.example.com",
    ]);
    expect(config.upstreams.rubygems).toBe("https://my-gems.example.com");
  });

  it("parses --go-upstream", () => {
    const config = loadConfig(["--go-upstream", "https://my-go.example.com"]);
    expect(config.upstreams.go).toBe("https://my-go.example.com");
  });

  it("parses --composer-upstream", () => {
    const config = loadConfig([
      "--composer-upstream",
      "https://my-composer.example.com",
    ]);
    expect(config.upstreams.composer).toBe("https://my-composer.example.com");
  });

  it("parses --maven-upstream", () => {
    const config = loadConfig([
      "--maven-upstream",
      "https://my-maven.example.com",
    ]);
    expect(config.upstreams.maven).toBe("https://my-maven.example.com");
  });

  it("parses --delay-days", () => {
    const config = loadConfig(["--delay-days", "14"]);
    expect(config.delayDays).toBe(14);
  });

  it("parses -d shorthand", () => {
    const config = loadConfig(["-d", "30"]);
    expect(config.delayDays).toBe(30);
  });

  it("parses fractional delay days", () => {
    const config = loadConfig(["--delay-days", "0.5"]);
    expect(config.delayDays).toBe(0.5);
  });

  it("parses multiple options together", () => {
    const config = loadConfig([
      "-p",
      "4000",
      "--npm-upstream",
      "https://npm.example.com",
      "--pypi-upstream",
      "https://pypi.example.com",
      "-d",
      "3",
    ]);
    expect(config.port).toBe(4000);
    expect(config.upstreams.npm).toBe("https://npm.example.com");
    expect(config.upstreams.pypi).toBe("https://pypi.example.com");
    expect(config.delayDays).toBe(3);
  });

  it("defaults upstreamAccess to direct", () => {
    const config = loadConfig([]);
    expect(config.upstreamAccess).toBe("direct");
  });

  it("parses --upstream-access proxied (with required --base-url)", () => {
    const config = loadConfig([
      "--upstream-access",
      "proxied",
      "--base-url",
      "https://tengen.example.com",
    ]);
    expect(config.upstreamAccess).toBe("proxied");
  });

  it("exits with an error when --upstream-access proxied is missing --base-url", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--upstream-access", "proxied"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with an error on an invalid --upstream-access", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--upstream-access", "bogus"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("leaves baseUrl undefined by default", () => {
    const config = loadConfig([]);
    expect(config.baseUrl).toBeUndefined();
  });

  it("parses --base-url", () => {
    const config = loadConfig(["--base-url", "https://tengen.example.com"]);
    expect(config.baseUrl).toBe("https://tengen.example.com");
  });

  it("strips a trailing slash from --base-url", () => {
    const config = loadConfig(["--base-url", "https://tengen.example.com/"]);
    expect(config.baseUrl).toBe("https://tengen.example.com");
  });

  it("exits with an error on a non-http(s) --base-url", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--base-url", "ftp://nope.example.com"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with an error on a malformed --base-url", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--base-url", "not a url"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("disables the Last-Modified fallback by default", () => {
    expect(loadConfig([]).mavenLastModifiedFallback).toBe(false);
  });

  it("parses --maven-last-modified-fallback", () => {
    const config = loadConfig(["--maven-last-modified-fallback"]);
    expect(config.mavenLastModifiedFallback).toBe(true);
  });

  it("lists --maven-last-modified-fallback in the help", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--help"])).toThrow("process.exit called");
    expect(String(consoleSpy.mock.calls[0]?.[0])).toContain(
      "--maven-last-modified-fallback",
    );
  });

  it("prints help and calls process.exit(0) when --help is passed", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--help"])).toThrow("process.exit called");
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
