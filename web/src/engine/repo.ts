// Loading any public GitHub repository into search units, entirely client-side.
import type { Parser } from "web-tree-sitter";
import { BM25 } from "./bm25.ts";
import { chunkFile } from "./chunk.ts";
import { LoadError, type RepoRef, isTestPath, parseRepo } from "./github.ts";
import type { Unit } from "./types.ts";

export { LoadError, githubUrl, isTestPath, parseRepo } from "./github.ts";

export const LIMITS = { maxFiles: 4000, maxBytes: 60e6, maxFileBytes: 1e6, concurrency: 16 };

export interface RepoCache {
  get(key: string): Promise<Unit[] | undefined>;
  put(key: string, units: Unit[]): Promise<unknown>;
}

export interface LoadedRepo {
  repo: string;
  branch: string;
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

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 403 || r.status === 429) {
    const reset = r.headers.get("x-ratelimit-reset");
    const when = reset ? ` (resets at ${new Date(1000 * Number(reset)).toLocaleTimeString()})` : "";
    throw new LoadError(`GitHub's API rate limit for your network was reached${when}.`, { rateLimited: true });
  }
  if (r.status === 404) throw new LoadError("Repository not found, or it is private.");
  if (!r.ok) throw new LoadError(`${url} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

interface Listing {
  branch: string;
  files: { path: string; size: number }[];
  truncated: boolean;
  via: string;
  sha: string | null;
}

// List files: GitHub's tree API, falling back to jsDelivr's listing when rate-limited.
async function listFiles({ owner, name, ref }: RepoRef): Promise<Listing> {
  try {
    const meta = await getJSON<{ default_branch: string }>(`https://api.github.com/repos/${owner}/${name}`);
    const branch = ref ?? meta.default_branch;
    const tree = await getJSON<{ sha: string; truncated: boolean; tree: { type: string; path: string; size?: number }[] }>(
      `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const files = tree.tree.filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size ?? 0 }));
    // The tree hash identifies this exact snapshot: a perfect, never-stale cache key.
    return { branch, files, truncated: tree.truncated, via: "GitHub API", sha: tree.sha };
  } catch (err) {
    if (!(err instanceof LoadError && err.rateLimited)) throw err;
    for (const branch of ref ? [ref] : ["main", "master"]) {
      const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${name}@${branch}?structure=flat`);
      if (!r.ok) continue;
      const data = (await r.json()) as { files: { name: string; size?: number }[] };
      return {
        branch, truncated: false, via: "jsDelivr", sha: null,
        files: data.files.map((f) => ({ path: f.name.replace(/^\//, ""), size: f.size ?? 0 })),
      };
    }
    throw err;
  }
}

async function fetchText(repo: RepoRef, branch: string, path: string): Promise<string | null> {
  const urls = [
    `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(branch)}/${path}`,
    `https://cdn.jsdelivr.net/gh/${repo.owner}/${repo.name}@${branch}/${path}`,
  ];
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

async function downloadAndParse(
  parser: Parser, repo: RepoRef, branch: string, files: { path: string }[],
  progress: Progress, signal: AbortSignal | null, notes: string[],
): Promise<Unit[]> {
  const units: Unit[] = [];
  let done = 0, failed = 0, next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      if (signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
      const f = files[next++];
      const text = await fetchText(repo, branch, f.path);
      if (text == null) failed++;
      else for (const c of chunkFile(parser, text)) if (c.text.trim()) units.push({ ...c, path: f.path, id: `${f.path}::${c.qualname}` });
      done++;
      if (signal?.aborted) continue; // no progress reports after a cancel
      if (done % 10 === 0 || done === files.length) progress("Downloading and parsing", done, files.length);
    }
  }
  await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
  if (failed) notes.push(`${failed} files could not be downloaded.`);
  // Files in path order, each file's units in source order: Odin's snapshot order, so ties
  // break the same way as in the evaluation. (A stable sort keeps each file's chunk order.)
  units.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return units;
}

/** Download, parse and index a repository; a revisit with the same tree hash hits `cache`. */
export async function loadRepo(
  parser: Parser, input: string,
  { includeTests = false, progress = () => {}, cache = null, signal = null }:
    { includeTests?: boolean; progress?: Progress; cache?: RepoCache | null; signal?: AbortSignal | null } = {},
): Promise<LoadedRepo> {
  const repo = parseRepo(input);
  progress("Listing files", 0, 1);
  const listing = await listFiles(repo);
  let files = listing.files.filter((f) => f.path.endsWith(".py") && f.size <= LIMITS.maxFileBytes);
  if (!includeTests) files = files.filter((f) => !isTestPath(f.path));
  const notes: string[] = [];
  if (!files.length) throw new LoadError("No Python files found. The in-browser version of Odin searches Python code only.");
  if (listing.truncated) notes.push("GitHub truncated the file list for this very large repository; some files are missing.");
  files.sort((a, b) => a.size - b.size);
  let bytes = 0;
  const kept: typeof files = [];
  for (const f of files) {
    if (kept.length >= LIMITS.maxFiles || bytes + f.size > LIMITS.maxBytes) break;
    kept.push(f);
    bytes += f.size;
  }
  if (kept.length < files.length) notes.push(`Indexed the ${kept.length} smallest of ${files.length} Python files to stay within browser limits.`);

  const key = listing.sha ? `v2|${repo.owner}/${repo.name}@${listing.sha}|${includeTests ? "tests" : "src"}` : null;
  const t0 = performance.now();
  let units = key && cache ? await cache.get(key) : undefined;
  const fromCache = !!units;
  if (!units) {
    units = await downloadAndParse(parser, repo, listing.branch, kept, progress, signal, notes);
    if (key && cache) await cache.put(key, units);
  }
  progress("Building the index", 0, 1);
  const t1 = performance.now();
  const index = new BM25(units);
  return {
    repo: `${repo.owner}/${repo.name}`, branch: listing.branch, via: listing.via, sha: listing.sha,
    files: kept.length, units, index, notes, fromCache,
    timings: { loadMs: t1 - t0, indexMs: performance.now() - t1 },
  };
}
