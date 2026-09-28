// Loading any public GitHub repository into search units, entirely client-side.
import type { Parser } from "web-tree-sitter";
import { BM25 } from "./bm25.ts";
import { chunkFile } from "./chunk.ts";
import { LoadError, type RepoRef, encodePath, isTestPath, parseRepo } from "./github.ts";
import type { Unit } from "./types.ts";

export { LoadError, githubUrl, isTestPath, parseRepo } from "./github.ts";

export const LIMITS = { maxFiles: 6000, maxBytes: 60e6, maxFileBytes: 1e6, concurrency: 16 };

export interface RepoCache {
  get(key: string): Promise<Unit[] | undefined>;
  put(key: string, units: Unit[]): Promise<unknown>;
}

export interface LoadedRepo {
  repo: string;
  branch: string;
  /** The folder the search is limited to (from a /tree/<branch>/<folder> link), if any. */
  scope: string | null;
  via: string;
  sha: string | null;
  files: number;
  units: Unit[];
  index: BM25;
  notes: string[];
  fromCache: boolean;
  timings: { loadMs: number; indexMs: number };
}

export type Progress = (phase: string, done: number, total: number) => void;

interface Entry {
  path: string;
  size: number;
}

interface Listing {
  owner: string;
  name: string;
  branch: string;
  scope: string | null;
  files: Entry[];
  truncated: boolean;
  via: string;
  /** Identifies this exact snapshot (a cache key), when the source provides one. */
  sha: string | null;
}

// Committed virtualenvs, installed packages and build output: never the project's own code.
const SKIP_DIR = /(^|\/)(site-packages|node_modules|\.?venv\d*|virtualenv|\.tox|\.nox|__pypackages__|\.eggs|build\/lib)(\/|$)/i;
// First to go when a repository exceeds the browser budget: docs, examples, benchmarks,
// vendored copies of other projects, generated protobuf modules and migrations.
const SECONDARY =
  /(^|\/)(docs?|examples?|samples?|demos?|benchmarks?|asv_bench|scripts|tools|contrib|third[_-]party|vendor(ed)?|_vendor|extern(al)?|migrations)(\/|$)|_pb2(_grpc)?\.py$/i;

const BLOCKED_HINT = "If you use an ad or privacy blocker, allow api.github.com, raw.githubusercontent.com and cdn.jsdelivr.net.";

async function getJSON<T>(url: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url);
  } catch {
    // No response at all: offline, a proxy, or an extension blocking the request.
    throw new LoadError(`Couldn't reach ${new URL(url).host}.`, { useMirror: true });
  }
  if (r.status === 403 || r.status === 429) {
    const reset = r.headers.get("x-ratelimit-reset");
    const when = reset ? ` until ${new Date(1000 * Number(reset)).toLocaleTimeString()}` : "";
    throw new LoadError(`GitHub's API limit for anonymous visitors on your network is used up${when}.`, { useMirror: true });
  }
  if (r.status === 404) throw new NotFound();
  if (r.status === 409) throw new LoadError("This repository is empty.");
  if (!r.ok) throw new LoadError(`GitHub answered HTTP ${r.status} for ${url}.`, { useMirror: r.status >= 500 });
  return r.json() as Promise<T>;
}

class NotFound extends Error {}

/**
 * Which part of a /tree/ link is the branch. "main/src/pkg" is branch main plus folder src/pkg,
 * but "stable/5.0.x" is one branch: try the shortest prefix first, as the common case.
 */
export function refCandidates(ref: string | null): [string, string | null][] {
  if (!ref) return [["HEAD", null]];
  const parts = ref.split("/").filter(Boolean);
  return parts.slice(0, 4).map((_, i) => [parts.slice(0, i + 1).join("/"), parts.slice(i + 1).join("/") || null]);
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Tree = { sha: string; url: string; truncated: boolean; tree: { type: string; mode: string; path: string; size?: number }[] };

// List files: GitHub's tree API, falling back to jsDelivr's listing when the API is
// rate-limited or unreachable. One API request per repository: anonymous visitors get 60
// an hour, and HEAD (the default branch) works for both the tree API and raw file URLs.
export async function listFiles({ owner, name, ref }: RepoRef): Promise<Listing> {
  const candidates = refCandidates(ref);
  try {
    for (const [branch, scope] of candidates) {
      let tree: Tree;
      try {
        tree = await getJSON<Tree>(`https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      } catch (err) {
        if (err instanceof NotFound) continue;
        throw err;
      }
      // The API follows renames and fixes letter case: raw file URLs need the canonical name.
      const canonical = tree.url?.match(/\/repos\/([^/]+)\/([^/]+)\/git\/trees\//);
      return {
        owner: canonical?.[1] ?? owner, name: canonical?.[2] ?? name, branch, scope,
        // mode 120000 is a symlink: its "content" is the target path, not code
        files: tree.tree.filter((t) => t.type === "blob" && t.mode !== "120000").map((t) => ({ path: t.path, size: t.size ?? 0 })),
        truncated: tree.truncated, via: "GitHub API",
        sha: tree.sha, // the tree hash identifies this exact snapshot: a perfect, never-stale cache key
      };
    }
    throw new LoadError(ref ? `Couldn't find ${owner}/${name} at "${ref}". Check the branch name; private repositories can't be searched.`
      : `Couldn't find ${owner}/${name}. Check the spelling; private repositories can't be searched.`);
  } catch (err) {
    if (!(err instanceof LoadError && err.useMirror)) throw err;
    const tries: [string, string | null][] = ref ? candidates : ["main", "master", "develop", "trunk"].map((b) => [b, null]);
    for (const [branch, scope] of tries) {
      let r: Response;
      try {
        r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${name}@${encodePath(branch)}?structure=flat`);
      } catch {
        continue;
      }
      if (!r.ok) continue;
      const data = (await r.json()) as { files: { name: string; hash?: string; size?: number }[] };
      const files = data.files.map((f) => ({ path: f.name.replace(/^\//, ""), size: f.size ?? 0 }));
      // jsDelivr lists a content hash per file: together they identify the snapshot.
      const hashes = data.files.every((f) => f.hash) ? await digest(data.files.map((f) => `${f.name}:${f.hash}`).join("\n")) : null;
      return { owner, name, branch, scope, files, truncated: false, via: "jsDelivr", sha: hashes && `jsd-${hashes}` };
    }
    const tried = ref ? "" : " (it tries the main, master, develop and trunk branches)";
    throw new LoadError(`${err.message} The jsDelivr mirror couldn't list this repository either${tried}. ${BLOCKED_HINT}`);
  }
}

async function fetchText(owner: string, name: string, branch: string, path: string): Promise<string | null> {
  const urls = [`https://raw.githubusercontent.com/${owner}/${name}/${encodePath(branch)}/${encodePath(path)}`];
  // jsDelivr has no HEAD; without a version it serves the latest tag, which could be different
  // code from the rest of the snapshot. Better a reported missing file than a mixed snapshot.
  if (branch !== "HEAD") urls.push(`https://cdn.jsdelivr.net/gh/${owner}/${name}@${encodePath(branch)}/${encodePath(path)}`);
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch {
      /* try the next mirror */
    }
  }
  return null;
}

/**
 * The Python files to index. Tests are left out unless asked for (or unless tests are all
 * there is); over the browser budget, the project's own code is kept first, in path order.
 */
export function selectFiles(listing: Pick<Listing, "files" | "scope">, includeTests: boolean, notes: string[]): Entry[] {
  const scope = listing.scope?.replace(/\/+$/, "");
  let py = listing.files.filter((f) => /\.py$/i.test(f.path) && !SKIP_DIR.test(f.path) && (!scope || f.path.startsWith(`${scope}/`)));
  const big = py.filter((f) => f.size > LIMITS.maxFileBytes).length;
  py = py.filter((f) => f.size <= LIMITS.maxFileBytes).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let files = includeTests ? py : py.filter((f) => !isTestPath(f.path));
  if (!files.length && py.length) {
    files = py;
    notes.push("This repository's Python code is all tests, so they're included.");
  }
  if (!files.length) {
    throw new LoadError(scope ? `No Python files under ${scope}/.` : "No Python files found. Odin searches Python code only for now.");
  }
  if (big) notes.push(`Skipped ${big} Python file${big > 1 ? "s" : ""} over 1 MB (usually generated code).`);
  const ordered = [...files.filter((f) => !SECONDARY.test(f.path)), ...files.filter((f) => SECONDARY.test(f.path))];
  const kept: Entry[] = [];
  let bytes = 0;
  for (const f of ordered) {
    if (kept.length >= LIMITS.maxFiles || bytes + f.size > LIMITS.maxBytes) continue;
    kept.push(f);
    bytes += f.size;
  }
  if (kept.length < files.length) {
    notes.push(`Indexed ${kept.length.toLocaleString()} of ${files.length.toLocaleString()} Python files to stay within browser limits; docs, examples and vendored code went first.`);
  }
  return kept;
}

async function downloadAndParse(
  parser: Parser, listing: Listing, files: Entry[], progress: Progress, signal: AbortSignal | null, notes: string[],
): Promise<Unit[]> {
  const units: Unit[] = [];
  let done = 0, failed = 0, unparsed = 0, next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      if (signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
      const f = files[next++];
      const text = await fetchText(listing.owner, listing.name, listing.branch, f.path);
      if (text == null) failed++;
      else {
        try {
          for (const c of chunkFile(parser, text)) if (c.text.trim()) units.push({ ...c, path: f.path, id: `${f.path}::${c.qualname}` });
        } catch {
          unparsed++; // one unparseable file should never sink the whole repository
        }
      }
      done++;
      if (signal?.aborted) continue; // no progress reports after a cancel
      if (done % 10 === 0 || done === files.length) progress("Downloading and parsing", done, files.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, files.length) }, worker));
  if (failed) notes.push(`${failed} file${failed > 1 ? "s" : ""} could not be downloaded.`);
  if (unparsed) notes.push(`${unparsed} file${unparsed > 1 ? "s" : ""} could not be parsed.`);
  // Files in path order, each file's units in source order: Odin's snapshot order, so ties
  // break the same way as in the evaluation. (A stable sort keeps each file's chunk order.)
  units.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return units;
}

/** Download, parse and index a repository; a revisit of the same snapshot hits `cache`. */
export async function loadRepo(
  parser: Parser, input: string,
  { includeTests = false, progress = () => {}, cache = null, signal = null }:
    { includeTests?: boolean; progress?: Progress; cache?: RepoCache | null; signal?: AbortSignal | null } = {},
): Promise<LoadedRepo> {
  const ref = parseRepo(input);
  progress("Listing files", 0, 1);
  const listing = await listFiles(ref);
  const notes: string[] = [];
  if (listing.truncated) notes.push("GitHub truncated the file list for this very large repository; some files are missing.");
  const kept = selectFiles(listing, includeTests, notes);

  const repo = `${listing.owner}/${listing.name}`;
  const key = listing.sha ? `v3|${repo}@${listing.sha}|${listing.scope ?? ""}|${includeTests ? "tests" : "src"}` : null;
  const t0 = performance.now();
  let loaded = key && cache ? await cache.get(key) : undefined;
  const fromCache = !!loaded;
  if (!loaded) {
    loaded = await downloadAndParse(parser, listing, kept, progress, signal, notes);
    if (!loaded.length) throw new LoadError("These Python files contain no functions or classes to search.");
    if (key && cache) await cache.put(key, loaded);
  }
  progress("Building the index", 0, 1);
  const t1 = performance.now();
  const index = new BM25(loaded);
  return {
    repo, branch: listing.branch, scope: listing.scope, via: listing.via, sha: listing.sha,
    files: kept.length, units: loaded, index, notes, fromCache,
    timings: { loadMs: t1 - t0, indexMs: performance.now() - t1 },
  };
}
