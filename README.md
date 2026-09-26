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
| `--maven-timestamp-source`  | `deps-dev`                             | Where the built-in Maven registry reads publish timestamps: `deps-dev` (Central only) or `last-modified`. Use `last-modified` when `--maven-upstream` points somewhere other than Central |
| `--maven-repo`              | _(none)_                               | Additional Maven repository as `<name>=<url>`, mounted at `/<name>` (repeatable). Always uses `last-modified` timestamps |
| `--ivy-repo`                | _(none)_                               | Ivy-layout repository as `<name>=<url>[,index=artifactory]`, mounted at `/<name>` (repeatable). Gates downloads on the revision's `ivys/ivy.xml`; `index=artifactory` also filters revision listings, which is what lets a dynamic revision resolve |
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
| `/{...}/maven-metadata.xml.{sha1,md5,sha256,sha512}`    | Checksum recomputed over the filtered XML                             |
| `/{...}/{version}/maven-metadata.xml`                   | Filtered — a snapshot's timestamped build; served whole or 404'd       |
| `/{group/as/path}/{artifactId}/{version}/{file}`        | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                                         | Passthrough                                                           |

**Metadata redirects are followed, never forwarded.** A Maven repository may answer `maven-metadata.xml` with a redirect rather than the document — `repo.scala-sbt.org/scalasbt/maven-releases` 302s to Central, `maven.google.com` 301s to `dl.google.com`, the Gradle Plugin Portal 303s to the hosting repo for a plugin's backing module. Handing that redirect to the client would send it to the upstream and skip the age and malicious filters entirely, so the hops (301, 302, 303, 307, 308) are followed server-side and the document they land on is filtered as usual. A relative `Location` is resolved against the request URL, as HTTP requires. A chain longer than three hops is answered with 502 rather than forwarded, for the same reason.

**Checksums are recomputed, never forwarded.** The metadata served here is filtered, so the upstream's checksum would not match it. All four algorithms a Maven client may ask for (`sha1`, `md5`, `sha256`, `sha512`) are computed over the filtered document; Maven 3.9 and Gradle both use the SHA-2 ones.

**Snapshots.** A `-SNAPSHOT` version has a second `maven-metadata.xml` inside its version directory describing one timestamped build. Its `<lastUpdated>` (or `<snapshot><timestamp>`) is the build's time, so no external lookup is needed — the document is served whole when that build is past the cooldown and 404'd when it is not. A snapshot under active development is therefore unavailable until its latest build ages, which is what a cooldown means for a mutable version; use the allowlist for exceptions. On the artifact-level listing, a `-SNAPSHOT` entry is probed through that same version-directory `maven-metadata.xml` rather than a `{artifact}-{version}.pom`, which snapshots do not have.

> **Note:** `maven-metadata.xml` does not include publication timestamps, so version timestamps are fetched from the [deps.dev API](https://api.deps.dev/) (`api.deps.dev`). This external call is made regardless of the `--maven-upstream` setting.

### Additional Maven repositories

deps.dev only indexes Maven Central, so the built-in `/maven` route is Central-only by default. Other Maven-layout repositories are declared with a repeatable `--maven-repo <name>=<url>` and mounted at their own top-level path:

```sh
tengen serve \
  --maven-repo sbt-releases=https://repo.scala-sbt.org/scalasbt/maven-releases \
  --maven-repo scala-nightlies=https://repo.scala-lang.org/artifactory/maven-nightlies
```

`/sbt-releases/...` and `/scala-nightlies/...` then behave exactly like `/maven/...` — same routing, metadata filtering and download gating.

Names must be a single lowercase path segment and cannot shadow a built-in registry (`npm`, `pypi`, `rubygems`, `go`, `composer`, `maven`, `gradle-plugins`).

**Timestamps outside Central.** These repositories read each version's publish time from the `Last-Modified` header of its POM instead of deps.dev.

`<lastUpdated>` records when the metadata was last rewritten, which is when its newest version appeared, so when that is already past the cooldown every version in the document is older still and none are probed — the common case costs no extra requests at all. Otherwise something landed inside the window and every version is probed, in parallel and through a short-lived cache.

Every version, not just the newest few: `<versions>` is **not** in publication order. A maintenance release lands after the next minor's first prerelease, and `org.apache.logging.log4j:log4j-core` ends its list at a 2024 prerelease while its newest release is from 2026 — so walking the list and stopping at the first old entry would let newer ones through. That matters most for exactly the releases a cooldown is meant to catch, since a security patch to a maintenance branch lands out of order by construction.

Two caveats:

- `Last-Modified` is the file's mtime on the upstream, not a publication date, and the two can be far apart. Artifactory-backed repositories rewrite it on re-sync: within a single version of `ch.epfl.scala:sbt-bloop` on `repo.scala-sbt.org`, `ivy.xml` reports 2018 and the jar reports 2021. Files of the same version need not agree. It is nonetheless the only per-version timestamp a plain Maven repository exposes, and it is monotonic enough for a cooldown of days — just don't read it as provenance.
- A version whose `Last-Modified` cannot be read is treated as unknown and excluded, the same as with a missing deps.dev record.
- Ties are normal: a repository that re-syncs stamps every file with the same mtime. When the filtered `<latest>` has to be chosen among versions sharing a timestamp, the document's own ordering decides, where Maven puts the newest last.

The same applies to the built-in route when `--maven-upstream` is pointed somewhere other than Central — pass `--maven-timestamp-source last-modified` in that case, otherwise every version comes back unknown and the metadata is served empty.

### Ivy repositories

sbt's built-in resolver set includes three Ivy-layout repositories, so proxying sbt means handling Ivy as well. Declare them with a repeatable `--ivy-repo <name>=<url>[,index=artifactory]`:

```sh
tengen serve \
  --ivy-repo sbt-plugins=https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases,index=artifactory \
  --ivy-repo typesafe-ivy=https://repo.typesafe.com/typesafe/ivy-releases,index=artifactory
```

Ivy lays artifacts out as `{org}/{module}(/scala_{v})(/sbt_{v})/{revision}/{type}s/{artifact}(-{classifier}).{ext}`, e.g. `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.3.4/ivys/ivy.xml`.

| Path pattern                                   | Action                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `/{org}/{module}/…/{revision}/{type}s/{file}`  | Gated on the revision's `ivys/ivy.xml`; 404 if inside the cooldown |
| `/{org}/{module}/…/` (a revision listing)      | With `index=artifactory`, generated with the allowed revisions only; otherwise passthrough |
| everything else                                | Passthrough                                                        |

The revision's age comes from one HEAD of its `ivys/ivy.xml`. Redirects are followed: `repo.scala-sbt.org` and `repo.typesafe.com` both 302 to the Artifactory instance that holds the file.

**Dynamic revisions need `index=artifactory`.** Ivy has no document listing a module's revisions — the equivalent of `maven-metadata.xml` does not exist. A client discovers them by reading the repository's directory index, which is HTML: presentation rather than protocol, differing between Artifactory, Nexus 2, Nexus 3 and Clojars. tengen does not read it. What it can do is answer that request itself from structured data, and `index=artifactory` says to.

A pinned revision is gated either way, which is how sbt resolves in practice — measured against sbt 1.10.7, it requests `{org}/{module}/{rev}/ivys/ivy.xml` directly with no listing.

#### Without an index

The cooldown still holds for a dynamic revision, but by refusing the artifact rather than by steering the choice. Measured with Coursier 2.1.25 against `sbt-plugin-releases` at `--delay-days 4000`:

```
GET /{module}/sbt_1.0/                          307   the listing passes through unfiltered
GET /{module}/sbt_1.0/{revision}/ivys/ivy.xml   404   the chosen revision is inside the window
Resolution error: not found
```

The resolver picks one revision, and on 404 it stops — it does not try the next one, and it does not fall back to an older allowed revision. So nothing inside the window is served, but a build on `latest.integration` breaks until the newest revision ages out.

#### With `index=artifactory`

tengen answers the listing itself with only the allowed revisions, so the resolver never sees one it cannot have:

```
GET /{module}/sbt_1.0/                          200   generated, 177 of the upstream's 381 revisions
GET /{module}/sbt_1.0/1.0.0-RC1+4-c5e24b66/…    307   the newest revision the listing offered
```

Only a directory that actually holds revisions is filtered. A path cannot say which one that is — `/ch.epfl.scala/sbt-bloop/` holds `scala_2.10` and `scala_2.12`, and `…/1.5.6/` holds `ivys` and `jars` — so the children decide: a child that dates is a revision. A directory whose children are not revisions is passed through untouched, because it has no revisions to hide:

```
GET /ch.epfl.scala/                             307   passthrough
GET /ch.epfl.scala/sbt-bloop/                   307   passthrough (cross-version directories)
GET /ch.epfl.scala/sbt-bloop/scala_2.12/        307   passthrough
GET /ch.epfl.scala/sbt-bloop/…/sbt_1.0/         200   filtered (this is where revisions live)
GET /ch.epfl.scala/sbt-bloop/…/1.5.6/           307   passthrough (ivys, jars)
```

If no child dates but the storage API says the children *do* hold artifact-type directories, they are revisions whose `ivy.xml` could not be read — that is answered with 502, never passed through. A directory whose revisions all sit inside the cooldown is a different case: they date fine, so the answer is a listing with nothing in it.

Same repository, same `--delay-days 3000`, Coursier resolved `latest.integration` to `1.0.0-RC1+4-c5e24b66` and fetched the jar.

The revision names come from Artifactory's storage API as JSON:

```
GET /artifactory/api/storage/{repo}/{path}
  -> { "children": [ { "uri": "/1.0.0", "folder": true }, … ], … }
```

Each revision is then dated by the same `ivys/ivy.xml` HEAD the download gate uses, so the listing and the gate can never disagree — the folder's own `lastModified` is *not* used, because Artifactory rewrites it on re-sync: one revision of `ch.epfl.scala:sbt-bloop` has a folder stamped 2021-04-14 holding an `ivy.xml` stamped 2019-11-06. Dating a listing therefore costs one HEAD per revision, bounded at 8 in flight and cached for 10 minutes.

The endpoint is resolved and verified at startup, not per request. Nothing about the URL's shape is assumed: Artifactory is commonly served under an `/artifactory` context path, but an on-prem deployment behind a reverse proxy can sit anywhere — including the host root — so where the API base ends and the repository key begins cannot be read off the URL. The configured URL is followed through its redirects (`repo.scala-sbt.org` and `repo.typesafe.com` both 302 to `scala.jfrog.io/artifactory/{repo}`), then every split of the resulting path is tried against the storage API and the one that answers with a readable `FolderInfo` wins. For `https://scala.jfrog.io/artifactory/sbt-plugin-releases` that rejects `apiBase=https://scala.jfrog.io, repo=artifactory` (404) and accepts `apiBase=…/artifactory, repo=sbt-plugin-releases`; for a reverse proxy publishing a repository at `https://repo.example.com/ivy-releases` the first split is already the right one. `api/system/version` is then read. Failure is fatal — a repository configured to filter its listings either can or tengen does not start:

```
  sbt-plugins  index via https://scala.jfrog.io/artifactory repo=sbt-plugin-releases (Artifactory 7.171.0)
```

The option is neither version-pinned nor host-pinned: the fields used here — `children[].uri`, `children[].folder` — have been in `FolderInfo` since Artifactory 2.2.1 and still are in 7.x, and a version or a URL pattern in configuration could not tell you whether a particular deployment answers, which is what the startup probe checks instead. If the API stops answering or changes shape at runtime, a listing request returns 502 rather than an unfiltered list.

Which revision the resolver picks out of the listing is its own version ordering, not the listing's order: without an index, in the run above, Coursier asked for `1.3.4+151-7c324c7c` while the listing ended at `1.3.4+160-681434ff`.

Malicious and allowlist lookups use the shared `maven` ecosystem, since OSV tracks JVM artifacts there regardless of repository layout.

### Gradle Plugin Portal

Served under `/gradle-plugins`. The portal uses the same Maven m2 layout, so the path patterns and gating behaviour are identical to [Maven](#maven) above (including the deps.dev timestamp lookup — plugin marker artifacts are indexed there under the Maven ecosystem). Malicious-package and allowlist entries are read from the shared `maven` ecosystem key, since OSV tracks Gradle plugin artifacts as Maven artifacts.
