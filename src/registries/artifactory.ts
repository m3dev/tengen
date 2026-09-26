import axios from 'axios';

/**
 * Minimal client for the parts of Artifactory's storage API that let a proxy
 * enumerate an Ivy repository's revisions.
 *
 * Ivy has no document listing a module's revisions — a client discovers them by
 * reading the repository's directory index, which is HTML, i.e. presentation
 * rather than protocol. Scraping it would mean tracking each server's markup as
 * it changes. Artifactory answers the same question as structured data instead:
 *
 *   GET {apiBase}/api/storage/{repo}/{path}
 *     -> application/vnd.org.jfrog.artifactory.storage.FolderInfo+json
 *        { "children": [ { "uri": "/1.0.0", "folder": true }, … ], … }
 *
 * `FolderInfo` has carried these fields since Artifactory 2.2.1 and still does
 * in 7.x, so this does not pin a major version. What it does instead is check at
 * startup that the endpoint answers and that the response actually has the shape
 * relied on here — a version string in configuration could not tell us that
 * about a particular deployment, and JFrog's SaaS moves versions continuously.
 */

export interface ArtifactoryEndpoint {
  /** Where the API lives, e.g. "https://scala.jfrog.io/artifactory". */
  apiBase: string;
  /** The repository key, e.g. "sbt-plugin-releases". */
  repo: string;
  /** Path of the configured root below the repository, "" when it is the root. */
  prefix: string;
}

/** Upper bound on redirect hops when resolving a configured URL. */
const MAX_REDIRECTS = 3;

/**
 * Work out where a repository URL's storage API lives, and confirm it answers.
 *
 * Nothing about the URL's shape is assumed. Artifactory is commonly served under
 * an `/artifactory` context path, but an on-prem deployment behind a reverse
 * proxy can sit anywhere — including the host root — so the split between the
 * API base and the repository key cannot be read off the URL. Instead every
 * split of the path is tried against the API itself, and the one that answers
 * with a readable `FolderInfo` is the answer. For
 * `https://scala.jfrog.io/artifactory/sbt-plugin-releases` that rejects
 * `apiBase=https://scala.jfrog.io, repo=artifactory` (404) and accepts
 * `apiBase=https://scala.jfrog.io/artifactory, repo=sbt-plugin-releases`; for a
 * proxy publishing a repository at `https://repo.example.com/ivy-releases` the
 * first split is already the right one.
 *
 * A configured URL may also be a redirector: `repo.scala-sbt.org/scalasbt/
 * sbt-plugin-releases` and `repo.typesafe.com/typesafe/ivy-releases` both 302 to
 * `scala.jfrog.io/artifactory/{repo}`. The redirect target is what identifies the
 * deployment, so it is followed first.
 */
export async function resolveArtifactoryEndpoint(
  upstream: string,
): Promise<{ endpoint: ArtifactoryEndpoint; version: string } | { error: string }> {
  const resolved = await followRedirects(upstream.replace(/\/+$/, ''));
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return { error: `'${resolved}' is not a URL` };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return {
      error: `${resolved} has no path, so it names no repository`,
    };
  }

  const tried: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const endpoint: ArtifactoryEndpoint = {
      apiBase: `${url.origin}${segments.slice(0, i).map((s) => `/${s}`).join('')}`,
      repo: segments[i]!,
      prefix: segments
        .slice(i + 1)
        .map((s) => `/${s}`)
        .join(''),
    };
    if (await fetchFolder(endpoint, '')) {
      const version = await fetchVersion(endpoint);
      if (!version) {
        return {
          error:
            `${endpoint.apiBase}/api/storage/${endpoint.repo} answers but ` +
            `${endpoint.apiBase}/api/system/version does not`,
        };
      }
      return { endpoint, version };
    }
    tried.push(`${endpoint.apiBase}/api/storage/${endpoint.repo}`);
  }

  return {
    error:
      `no Artifactory storage API found for ${resolved} — none of these ` +
      `returned a readable FolderInfo (a children array of {uri, folder}): ` +
      tried.join(', '),
  };
}

/** Follow redirects from a URL until it stops redirecting. */
async function followRedirects(url: string): Promise<string> {
  let current = url;
  for (let hops = 0; hops < MAX_REDIRECTS; hops++) {
    const res = await axios.head(`${current}/`, {
      validateStatus: () => true,
      maxRedirects: 0,
    });
    const location = res.headers['location'];
    if (typeof location !== 'string') return current;
    try {
      current = new URL(location, `${current}/`).toString().replace(/\/+$/, '');
    } catch {
      return current;
    }
  }
  return current;
}

async function fetchVersion(
  endpoint: ArtifactoryEndpoint,
): Promise<string | null> {
  const res = await axios.get<{ version?: string }>(
    `${endpoint.apiBase}/api/system/version`,
    { validateStatus: () => true, maxRedirects: MAX_REDIRECTS },
  );
  if (res.status !== 200) return null;
  const version = res.data?.version;
  return typeof version === 'string' && version !== '' ? version : null;
}

interface FolderChild {
  uri?: unknown;
  folder?: unknown;
}

interface FolderInfo {
  children?: unknown;
}

/**
 * List the child folder names of a path, or null when the response is not a
 * FolderInfo we can read.
 */
export async function listFolders(
  endpoint: ArtifactoryEndpoint,
  path: string,
): Promise<string[] | null> {
  return await fetchFolder(endpoint, path);
}

async function fetchFolder(
  endpoint: ArtifactoryEndpoint,
  path: string,
): Promise<string[] | null> {
  const url =
    `${endpoint.apiBase}/api/storage/${endpoint.repo}` +
    `${endpoint.prefix}${path}`;
  const res = await axios.get<FolderInfo>(url, {
    validateStatus: () => true,
    maxRedirects: MAX_REDIRECTS,
  });
  if (res.status !== 200) return null;
  const body = res.data;
  if (!body || !Array.isArray(body.children)) return null;

  const children: string[] = [];
  for (const raw of body.children as FolderChild[]) {
    if (raw?.folder !== true || typeof raw.uri !== 'string') continue;
    children.push(raw.uri.replace(/^\//, ''));
  }
  return children;
}
