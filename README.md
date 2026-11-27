# tengen

<p align="center">
  <img width="256" alt="tengen" src="https://github.com/user-attachments/assets/8b507bc1-31eb-43ce-b0c3-ae92d10c75ea" />
</p>

Package registry proxy that filters out new and known-malicious package versions.

New versions are hidden until they have been published for a configurable number of days, and any version listed in the [ossf/malicious-packages](https://github.com/ossf/malicious-packages) database is permanently blocked. This gives your environment time to detect supply chain attacks or regressions before they land.

## How it works

tengen sits between your package manager and the upstream registry. On each metadata request it:

1. **Filters by age** — strips versions published within `--delay-days` days so they are invisible to the package manager.
2. **Honours the allowlist** — packages or versions listed in the optional allowlist bypass the age filter, so first-party packages stay available immediately (the malicious-package check still applies).
3. **Blocks malicious versions** — checks the requested package and version against a local copy of the OSSF malicious-packages database and returns 404 for any match.
4. **Serves downloads** — artifact downloads (tarballs, JARs, wheels, etc.) for allowed versions are either redirected (307) to the upstream URL or streamed back through the proxy, depending on `--upstream-access`.

```
npm install foo / pip install bar / gem install baz / ...
  └─> tengen
        ├─> filters new versions (age > --delay-days)
        ├─> allows allowlisted packages/versions through the age filter
        ├─> blocks known-malicious versions (ossf/malicious-packages)
        └─> upstream registry (npmjs.org / pypi.org / rubygems.org / ...)
```

## Quick start

```sh
npm start                             # runs `tengen serve`
```

The proxy listens on `http://localhost:3000` by default. On startup `serve` builds a fresh malicious-package database into a temp file (unless `--malicious-db-path` points at an existing one).

## CLI

### `tengen serve`

Start the registry proxy server.

| Option                      | Default                                | Description                                                                                    |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `-h, --host`                | `127.0.0.1`                            | Host address to bind on                                                                        |
| `-p, --port`                | `3000`                                 | Port to listen on                                                                              |
| `-d, --delay-days`          | `7`                                    | Exclude versions published within this many days                                               |
| `--upstream-access`        | `direct`                             | How downloads are served: `direct` (307 to upstream) or `proxied` (stream through the proxy)    |
| `--base-url`                | _(none)_                               | Absolute base URL (e.g. `https://tengen.example.com`); used to rewrite npm `dist.tarball` so clients fetch through the proxy. Required when using `proxied` mode |
| `--npm-upstream`            | `https://registry.npmjs.org`           | Upstream URL for npm                                                                           |
| `--pypi-upstream`           | `https://pypi.org`                     | Upstream URL for PyPI                                                                          |
| `--rubygems-upstream`       | `https://rubygems.org`                 | Upstream URL for RubyGems                                                                      |
| `--go-upstream`             | `https://proxy.golang.org`             | Upstream URL for Go module proxy                                                               |
| `--composer-upstream`       | `https://packagist.org`                | Upstream URL for Composer (Packagist)                                                          |
| `--maven-upstream`          | `https://repo.maven.apache.org/maven2` | Upstream URL for Maven Central                                                                 |
| `--gradle-plugins-upstream` | `https://plugins.gradle.org/m2`        | Upstream URL for the Gradle Plugin Portal                                                      |
| `--malicious-db-path`       | _(built into a temp file)_             | Path to the combined malicious-package DB JSON; built into a temp file on startup when omitted |
| `--allowlist-db-path`       | _(none)_                               | Path to the combined allowlist JSON (per-registry exemptions from the age filter)              |

### `tengen build-malicious-db`

Download and build the malicious-package database.

| Option         | Default      | Description                                            |
| -------------- | ------------ | ------------------------------------------------------ |
| `-o, --output` | _(required)_ | Output path for the combined malicious-package DB JSON |

## Malicious-package database

tengen reads from a single combined JSON file built from the [ossf/malicious-packages](https://github.com/ossf/malicious-packages) OSV feed. The file holds every supported ecosystem keyed by registry name:

```jsonc
{
  "npm": {
    "maliciousPackages": ["evil-pkg"],
    "maliciousVersions": { "left-pad": ["9.9.9"] },
  },
  "pypi": { "maliciousPackages": [], "maliciousVersions": {} },
  "rubygems": { "maliciousPackages": [], "maliciousVersions": {} },
  "go": { "maliciousPackages": [], "maliciousVersions": {} },
  "composer": { "maliciousPackages": [], "maliciousVersions": {} },
  "maven": { "maliciousPackages": [], "maliciousVersions": {} },
}
```

- `maliciousPackages` — every version of these packages is blocked.
- `maliciousVersions` — only the listed versions are blocked.

```sh
# Build (requires internet access; set GITHUB_TOKEN for a higher rate limit)
GITHUB_TOKEN=ghp_xxx npm run build:malicious-db -- -o data/malicious-db.json
```

Then start the proxy with `--malicious-db-path data/malicious-db.json`, or omit the flag and let `serve` build a fresh copy into a temp file on startup. If the file cannot be read or has no entries for a registry, the malicious-package check is skipped for that registry and only the age filter applies.

## Allowlist

An optional allowlist exempts specific packages or versions from the age-delay filter — handy for internal/first-party packages you publish and want available immediately. Point the proxy at a combined JSON file with `--allowlist-db-path`. Same per-registry shape as the malicious DB:

```jsonc
{
  "npm": {
    "allowlistedPackages": ["@myorg/internal-lib"],
    "allowlistedVersions": { "left-pad": ["1.3.0"] },
  },
  "pypi": { "allowlistedPackages": [], "allowlistedVersions": {} },
}
```

- `allowlistedPackages` — every version of these packages bypasses the age filter.
- `allowlistedVersions` — only the listed versions bypass the age filter.

The malicious-package check still applies to allowlisted entries, so a version that is both allowlisted and known-malicious stays blocked.

## Upstream access

`--upstream-access` controls how artifact downloads (and other passthrough requests) reach the upstream:

- `direct` (default) — respond with a 307 pointing at the upstream URL, so the client downloads directly from the upstream registry.
- `proxied` — stream the upstream response back through the proxy. Use this when clients can only reach the proxy and must not talk to the upstream directly.

### Artifact URL rewriting and `--base-url`

Package metadata often embeds absolute artifact URLs that point at the upstream registry — npm's `dist.tarball` (e.g. `https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz`) and PyPI's Simple/JSON API file URLs (`https://files.pythonhosted.org/packages/...`). In `proxied` mode the upstream is unreachable, so the proxy rewrites these to absolute URLs that point at itself (`<base-url>/npm/...`, `<base-url>/pypi/...`) so clients fetch artifacts through the proxy rather than the unreachable upstream — the npm CLI rewrites the tarball host itself, but yarn, pnpm, and JSON-API consumers use the embedded URLs verbatim.

In `direct` mode the upstream is reachable, so all of these URLs (npm's `dist.tarball`, the PyPI Simple and JSON API file URLs) are left pointing at it and the client downloads directly from the upstream. Blocked versions are already removed from the filtered metadata, so only allowed artifacts are ever referenced.

The proxy needs to know its own externally-visible URL to build these links, so `--base-url` is **required** in `proxied` mode — startup fails with an error if it is missing. It must be an absolute URL — npm treats a relative `dist.tarball` as a local file path, so a root-relative path does not work:

```sh
tengen serve --upstream-access proxied --base-url https://tengen.example.com
```

## Package manager configuration

Point each package manager at the running proxy (default: `http://localhost:3000`).

#### npm

```sh
npm config set registry http://localhost:3000/npm
```

#### yarn classic (v1)

```sh
yarn config set registry http://localhost:3000/npm
```

#### yarn berry (v2+)

```sh
yarn config set npmRegistryServer http://localhost:3000/npm
```

#### pnpm

```sh
pnpm config set registry http://localhost:3000/npm
```

#### pip

```sh
pip config set global.index-url http://localhost:3000/pypi/simple/
```

#### uv

```toml
# uv.toml
index-url = "http://localhost:3000/pypi/simple/"
```

#### poetry

```toml
# pyproject.toml
[[tool.poetry.source]]
name = "tengen"
url  = "http://localhost:3000/pypi/simple/"
```

#### bundler

```ruby
# Gemfile
source "http://localhost:3000/rubygems"
```

#### go

```sh
go env -w GOPROXY=http://localhost:3000/go
```

#### composer

```sh
composer config repositories.tengen composer http://localhost:3000/composer
composer config repositories.packagist.org false
```

#### maven / gradle

See the [`examples/maven`](examples/maven/) and [`examples/gradle`](examples/gradle/) directories for ready-to-run configuration.

## Examples

The `examples/` directory contains a working demo that freezes the visible package universe at **2025-01-01** — versions published after that date are hidden.

Start the demo server:

```sh
cd examples
./run-server.sh
```

Then point your package manager at `http://localhost:3000`. Each subdirectory has a ready-to-run `install.sh`.

Available examples: `bundler`, `composer`, `go`, `gradle`, `maven`, `npm`, `pip`, `pnpm`, `poetry`, `uv`, `yarn-berry`, `yarn-classic`.

## Filtered paths per registry

### npm

| Path pattern                                  | Action                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `/{package}` / `/@scope/{package}` (no `/-/`) | Filtered — version metadata                                           |
| `/{package}/-/{tarball}.tgz` (contains `/-/`) | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                               | Passthrough                                                           |

### PyPI

| Path pattern                  | Action                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| `/simple/{name}`              | Filtered — Simple API (HTML or JSON)                                  |
| `/pypi/{name}/json`           | Filtered — JSON API (package-level metadata)                          |
| `/pypi/{name}/{version}/json` | Filtered — JSON API (version-specific metadata)                       |
| `/packages/...`               | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else               | Passthrough                                                           |

### RubyGems

| Path pattern                   | Action                                                                |
| ------------------------------ | --------------------------------------------------------------------- |
| `/info/{name}`                 | Filtered — Compact Index per-gem info                                 |
| `/api/v1/versions/{name}.json` | Filtered — JSON versions API                                          |
| `/gems/{name}-{version}.gem`   | Download — redirect to upstream if allowed; 404 if version is blocked |
| `/versions`                    | Proxied directly (compact index protocol)                             |
| everything else                | Passthrough                                                           |

### Go module

| Path pattern                        | Action                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| `/{module}/@v/list`                 | Filtered — version list                                               |
| `/{module}/@latest`                 | Filtered — latest version info                                        |
| `/{module}/@v/{version}.(zip\|mod)` | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                     | Passthrough                                                           |

### Composer

| Path pattern                      | Action                                                   |
| --------------------------------- | -------------------------------------------------------- |
| `/packages.json`                  | Filtered — registry root (URL fields rewritten to proxy) |
| `/p2/{vendor}/{package}.json`     | Filtered — package metadata                              |
| `/p2/{vendor}/{package}~dev.json` | Filtered — dev-channel metadata                          |
| everything else                   | Passthrough                                              |

### Maven

| Path pattern                                            | Action                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `/{group/as/path}/{artifactId}/maven-metadata.xml`      | Filtered — version metadata XML                                       |
| `/{group/as/path}/{artifactId}/maven-metadata.xml.sha1` | Filtered — SHA1 checksum of filtered XML                              |
| `/{group/as/path}/{artifactId}/maven-metadata.xml.md5`  | Filtered — MD5 checksum of filtered XML                               |
| `/{group/as/path}/{artifactId}/{version}/{file}`        | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                                         | Passthrough                                                           |

> **Note:** `maven-metadata.xml` does not include publication timestamps, so version timestamps are fetched from the [deps.dev API](https://api.deps.dev/) (`api.deps.dev`). This external call is made regardless of the `--maven-upstream` setting.

**Fallback to `Last-Modified`.** deps.dev lags behind Central and knows nothing of artifacts hosted elsewhere, such as plugins that `/gradle-plugins` resolves from outside Central. A version deps.dev has no date for — no record, an answer without `publishedAt`, or an error — is dated by the `Last-Modified` header of its POM on the upstream (redirects are followed). A date from deps.dev is never overridden by `Last-Modified`, and a version with neither stays blocked. Versions deps.dev dates cost no extra request; the others are probed in parallel and through a short-lived cache. Each probe is logged as `[last-modified] <url> -> <status> <date>`, so the versions released this way can be traced.

`Last-Modified` is the file's mtime on the upstream, not a publication date. A repository that re-syncs can rewrite it, so don't read it as provenance. When several versions share one timestamp, the later entry in `maven-metadata.xml` becomes `<latest>` and `<release>`.

### Gradle Plugin Portal

Served under `/gradle-plugins`. The portal uses the same Maven m2 layout, so the path patterns and gating behaviour are identical to [Maven](#maven) above (including the deps.dev timestamp lookup — plugin marker artifacts are indexed there under the Maven ecosystem — and the `Last-Modified` fallback for versions deps.dev has no date for). Malicious-package and allowlist entries are read from the shared `maven` ecosystem key, since OSV tracks Gradle plugin artifacts as Maven artifacts.
