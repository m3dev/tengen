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
  /**
   * Additional Maven-layout repositories, each mounted at its own top-level path
   * (`/{name}`). Declared with a repeatable `--maven-repo <name>=<url>`.
   *
   * These read publish timestamps from the upstream's `Last-Modified` headers,
   * since deps.dev only indexes Maven Central.
   */
  mavenRepos?: { name: string; upstream: string }[];
  /** Where the built-in Maven registry reads publish timestamps from */
  mavenTimestampSource?: 'deps-dev' | 'last-modified';
  /**
   * Ivy-layout repositories, each mounted at its own top-level path (`/{name}`).
   * Declared with a repeatable `--ivy-repo <name>=<url>`.
   */
  ivyRepos?: {
    name: string;
    upstream: string;
    /**
     * Source for the module's revision listing. Without it a dynamic revision
     * cannot resolve to an allowed revision — see IvyRegistryProxy.
     */
    index?: 'artifactory';
  }[];
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
  "maven-repo": {
    type: "string" as const,
    multiple: true as const,
    description:
      "Additional Maven repository as <name>=<url>, mounted at /<name> (repeatable). Timestamps come from the upstream's Last-Modified header, since deps.dev only indexes Central",
  },
  "ivy-repo": {
    type: "string" as const,
    multiple: true as const,
    description:
      "Ivy-layout repository as <name>=<url>[,index=artifactory], mounted at /<name> (repeatable). Downloads are gated on the revision's ivy.xml; add index=artifactory to also serve filtered revision listings, which is what lets a dynamic revision resolve",
  },
  "maven-timestamp-source": {
    type: "string" as const,
    default: "deps-dev",
    description:
      "Where the built-in Maven registry reads publish timestamps: 'deps-dev' (Central only) or 'last-modified'. Use 'last-modified' when --maven-upstream points somewhere other than Central",
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

/** Names already taken by the built-in registries; an extra repo cannot shadow one. */
const RESERVED_REGISTRY_NAMES = new Set([
  "npm",
  "pypi",
  "rubygems",
  "go",
  "composer",
  "maven",
  "gradle-plugins",
]);

/** A mount name has to be a single safe path segment. */
const REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Parse repeated `--<flag> <name>=<url>` values.
 *
 * Exits with a message rather than throwing: a malformed repository definition
 * would otherwise surface as a confusing 404 at request time.
 */
function parseNamedRepos<T extends { name: string; upstream: string }>(
  raw: string[],
  flag: string,
  /**
   * Splits any trailing `,<option>=<value>` off the URL. Applied before the URL
   * is validated, so validation and the trailing-slash trim see the URL itself
   * and an error message quotes only that.
   */
  splitOptions: (repo: { name: string; upstream: string }) => T = (repo) =>
    repo as T,
): T[] {
  const repos: T[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      console.error(
        `Error: invalid --${flag} '${entry}' (expected <name>=<url>, e.g. sbt-releases=https://repo.scala-sbt.org/scalasbt/maven-releases)`,
      );
      process.exit(1);
    }
    const name = entry.slice(0, separator).trim();
    const split = splitOptions({
      name,
      upstream: entry.slice(separator + 1).trim(),
    });
    const upstream = split.upstream;

    if (!REPO_NAME_PATTERN.test(name)) {
      console.error(
        `Error: invalid --${flag} name '${name}' (expected a lowercase path segment matching ${REPO_NAME_PATTERN})`,
      );
      process.exit(1);
    }
    if (RESERVED_REGISTRY_NAMES.has(name)) {
      console.error(
        `Error: --${flag} name '${name}' is reserved by a built-in registry`,
      );
      process.exit(1);
    }
    if (seen.has(name)) {
      console.error(`Error: duplicate --${flag} name '${name}'`);
      process.exit(1);
    }
    try {
      const parsed = new URL(upstream);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("must use http or https");
      }
    } catch {
      console.error(
        `Error: invalid --${flag} url '${upstream}' for '${name}' (expected an absolute http(s) URL)`,
      );
      process.exit(1);
    }

    seen.add(name);
    repos.push({ ...split, upstream: split.upstream.replace(/\/+$/, "") });
  }

  return repos;
}

/** Sources a `--ivy-repo` can read a module's revision listing from. */
const IVY_INDEX_SOURCES = ["artifactory"] as const;

/**
 * Split a trailing `,index=<source>` off an --ivy-repo URL.
 *
 * The listing is what a resolver picks a dynamic revision from, so where it
 * comes from is stated explicitly rather than guessed from the URL.
 */
function parseIvyIndexOption(repo: { name: string; upstream: string }): {
  name: string;
  upstream: string;
  index?: (typeof IVY_INDEX_SOURCES)[number];
} {
  const match = /^(.*),index=([^,]*)$/.exec(repo.upstream);
  if (!match) return repo;
  const source = match[2]!;
  if (!(IVY_INDEX_SOURCES as readonly string[]).includes(source)) {
    console.error(
      `Error: invalid index source '${source}' for --ivy-repo '${repo.name}' ` +
        `(expected one of: ${IVY_INDEX_SOURCES.join(", ")})`,
    );
    process.exit(1);
  }
  return {
    name: repo.name,
    upstream: match[1]!,
    index: source as (typeof IVY_INDEX_SOURCES)[number],
  };
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

  const mavenTimestampSource = values["maven-timestamp-source"] as string;
  if (
    mavenTimestampSource !== "deps-dev" &&
    mavenTimestampSource !== "last-modified"
  ) {
    console.error(
      `Error: invalid --maven-timestamp-source '${mavenTimestampSource}' (expected 'deps-dev' or 'last-modified')`,
    );
    process.exit(1);
  }

  const mavenRepos = parseNamedRepos(
    (values["maven-repo"] as string[] | undefined) ?? [],
    "maven-repo",
  );
  const ivyRepos = parseNamedRepos(
    (values["ivy-repo"] as string[] | undefined) ?? [],
    "ivy-repo",
    parseIvyIndexOption,
  );

  const clash = mavenRepos.find((m) => ivyRepos.some((i) => i.name === m.name));
  if (clash) {
    console.error(
      `Error: '${clash.name}' is declared as both a --maven-repo and an --ivy-repo`,
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
    mavenRepos,
    mavenTimestampSource,
    ivyRepos,
    delayDays: parseFloat(values["delay-days"] as string),
    maliciousDbPath: values["malicious-db-path"] as string,
    allowlistDbPath: (values["allowlist-db-path"] as string) || undefined,
    upstreamAccess,
    baseUrl,
  };
}
