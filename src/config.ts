import { parseArgs as nodeParseArgs } from "node:util";

export interface Config {
  /** Host address to bind on */
  host: string;
  /** Port to listen on */
  port: number;
  /** Upstream registry base URLs per package manager */
  upstreams: {
    npm: string;
    pypi: string;
    rubygems: string;
    go: string;
    composer: string;
    maven: string;
    gradlePlugins: string;
  };
  /** Versions published within this many days are excluded from responses */
  delayDays: number;
  /** Path to a single combined malicious DB JSON file */
  maliciousDbPath: string;
  /** Optional path to a single combined allowlist JSON file */
  allowlistDbPath?: string;
  /**
   * How passthrough/download requests are served:
   * - "direct": respond with a 307 pointing at the upstream URL
   * - "proxied": stream the upstream response back through the proxy
   */
  upstreamAccess: "direct" | "proxied";
  /**
   * Externally-visible base URL of this proxy (e.g. "https://tengen.example.com").
   * Used to rewrite upstream artifact URLs embedded in metadata — most notably
   * npm `dist.tarball` — so clients fetch artifacts through the proxy instead of
   * talking to the upstream directly. Only applied in `proxied` mode, where the
   * upstream is unreachable; in `direct` mode the upstream URL is left as-is.
   * Must be an absolute http(s) URL: npm treats a relative `dist.tarball` as a
   * local file path, so a root-absolute path does not work. Required in `proxied`
   * mode (the loader errors without it); unused in `direct` mode.
   */
  baseUrl?: string;
  /**
   * Date Maven and Gradle Plugin Portal versions that deps.dev has no date for
   * by the `Last-Modified` header of their POM on the upstream. When unset, such
   * versions stay blocked.
   */
  mavenLastModifiedFallback?: boolean;
}

const OPTIONS = {
  host: {
    type: "string" as const,
    short: "h",
    default: "127.0.0.1",
    description: "Host address to bind on",
  },
  port: {
    type: "string" as const,
    short: "p",
    default: "3000",
    description: "Port to listen on",
  },
  "npm-upstream": {
    type: "string" as const,
    default: "https://registry.npmjs.org",
    description: "Upstream URL for npm",
  },
  "pypi-upstream": {
    type: "string" as const,
    default: "https://pypi.org",
    description: "Upstream URL for PyPI",
  },
  "rubygems-upstream": {
    type: "string" as const,
    default: "https://rubygems.org",
    description: "Upstream URL for RubyGems",
  },
  "go-upstream": {
    type: "string" as const,
    default: "https://proxy.golang.org",
    description: "Upstream URL for Go module proxy",
  },
  "composer-upstream": {
    type: "string" as const,
    default: "https://packagist.org",
    description: "Upstream URL for Composer (Packagist)",
  },
  "maven-upstream": {
    type: "string" as const,
    default: "https://repo.maven.apache.org/maven2",
    description: "Upstream URL for Maven Central",
  },
  "gradle-plugins-upstream": {
    type: "string" as const,
    default: "https://plugins.gradle.org/m2",
    description: "Upstream URL for the Gradle Plugin Portal",
  },
  "delay-days": {
    type: "string" as const,
    short: "d",
    default: "7",
    description: "Exclude versions published within this many days",
  },
  "malicious-db-path": {
    type: "string" as const,
    default: "",
    description: "Path to the malicious DB JSON file (built automatically into tmpdir when omitted)",
  },
  "allowlist-db-path": {
    type: "string" as const,
    default: "",
    description: "Path to the allowlist DB JSON file (per-registry exemptions from the age filter)",
  },
  "upstream-access": {
    type: "string" as const,
    default: "direct",
    description:
      "How to serve passthrough/download requests: 'direct' (307 to upstream) or 'proxied' (stream the upstream response through the proxy)",
  },
  "base-url": {
    type: "string" as const,
    default: "",
    description:
      "Absolute base URL of this proxy (e.g. https://tengen.example.com); used to rewrite artifact URLs like npm dist.tarball so clients fetch through the proxy. Required when using --upstream-access proxied",
  },
  "maven-last-modified-fallback": {
    type: "boolean" as const,
    description:
      "Date Maven/Gradle Plugin Portal versions that deps.dev has no date for by the Last-Modified header of their POM (default: off, such versions stay blocked)",
  },
  help: {
    type: "boolean" as const,
    description: "Show this help message",
  },
};

function buildHelp(): string {
  const lines = ["Usage: tengen [options]", "", "Options:"];
  for (const [name, opt] of Object.entries(OPTIONS)) {
    const short = "short" in opt ? `-${opt.short}, ` : "    ";
    const flag = `  ${short}--${name}${"default" in opt ? " <value>" : ""}`;
    const desc =
      "default" in opt
        ? `${opt.description} (default: ${opt.default})`
        : opt.description;
    lines.push(`${flag.padEnd(36)}${desc}`);
  }
  return lines.join("\n");
}

export function loadConfig(argv = process.argv.slice(2)): Config {
  const { values } = nodeParseArgs({ args: argv, options: OPTIONS });

  if (values["help"]) {
    console.log(buildHelp());
    process.exit(0);
  }

  const upstreamAccess = values["upstream-access"] as string;
  if (upstreamAccess !== "direct" && upstreamAccess !== "proxied") {
    console.error(
      `Error: invalid --upstream-access '${upstreamAccess}' (expected 'direct' or 'proxied')`,
    );
    process.exit(1);
  }

  const rawBaseUrl = (values["base-url"] as string).trim();
  let baseUrl: string | undefined;
  if (rawBaseUrl) {
    try {
      const parsed = new URL(rawBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("must use http or https");
      }
      // Normalize: drop any trailing slash so callers can append paths directly.
      baseUrl = rawBaseUrl.replace(/\/+$/, "");
    } catch {
      console.error(
        `Error: invalid --base-url '${rawBaseUrl}' (expected an absolute http(s) URL like https://tengen.example.com)`,
      );
      process.exit(1);
    }
  }

  if (upstreamAccess === "proxied" && !baseUrl) {
    // In proxied mode the upstream is unreachable, so artifact URLs (npm
    // dist.tarball) must be rewritten to point at this proxy — which requires
    // knowing its externally-visible URL.
    console.error(
      "Error: --upstream-access 'proxied' requires --base-url (this proxy's " +
        "externally-visible URL, e.g. https://tengen.example.com) so artifact " +
        'URLs embedded in metadata (npm dist.tarball, PyPI file URLs) can be ' +
        'rewritten to point at the proxy instead of the unreachable upstream',
    );
    process.exit(1);
  }

  return {
    host: values["host"] as string,
    port: parseInt(values["port"] as string, 10),
    upstreams: {
      npm: values["npm-upstream"] as string,
      pypi: values["pypi-upstream"] as string,
      rubygems: values["rubygems-upstream"] as string,
      go: values["go-upstream"] as string,
      composer: values["composer-upstream"] as string,
      maven: values["maven-upstream"] as string,
      gradlePlugins: values["gradle-plugins-upstream"] as string,
    },
    delayDays: parseFloat(values["delay-days"] as string),
    maliciousDbPath: values["malicious-db-path"] as string,
    allowlistDbPath: (values["allowlist-db-path"] as string) || undefined,
    upstreamAccess,
    baseUrl,
    mavenLastModifiedFallback: values["maven-last-modified-fallback"] === true,
  };
}
