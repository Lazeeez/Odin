// Loading any public GitHub repository into search units, entirely client-side.
import type { Parser } from "web-tree-sitter";
import { BM25, type TermCounts, unitCounts } from "./bm25.ts";
import { chunkFile } from "./chunk.ts";
import { untar } from "./tarball.ts";
import { LoadError, type RepoRef, encodePath, githubApi, isTestPath, parseRepo } from "./github.ts";
import type { Unit } from "./types.ts";

export { LoadError, githubUrl, isTestPath, parseRepo } from "./github.ts";

export const LIMITS = { maxFiles: 6000, maxBytes: 60e6, maxFileBytes: 1e6, concurrency: 16 };

export interface RepoCache {
  get(key: string): Promise<Unit[] | undefined>;
  put(key: string, units: Unit[]): Promise<unknown>;
  /** A recent file listing of `ref`, so a reload costs no GitHub API request. */
  getListing?(ref: string): Promise<Listing | undefined>;
  putListing?(ref: string, listing: Listing): Promise<unknown>;
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
/** Units parsed so far during a long load (files in path order), to search before it ends. */
export type Partial = (
  units: Unit[], counts: TermCounts[], filesDone: number, filesTotal: number,
  where: { repo: string; branch: string; scope: string | null },
) => void;
/** How often a long load offers what it has so far. */
export const PARTIAL_EVERY_MS = 2500;

/** How files become units: parser threads in the browser, one inline parser elsewhere. */
export interface Parsing {
  threads: number;
  parse(path: string, text: string): Promise<{ units: Unit[]; counts: TermCounts[] }>;
  count(units: Unit[]): Promise<TermCounts[]>;
}

export function inlineParsing(parser: Parser): Parsing {
  return {
    threads: 1,
    async parse(path, text) {
      const units: Unit[] = [];
      for (const c of chunkFile(parser, text)) if (c.text.trim()) units.push({ ...c, path, id: `${path}::${c.qualname}` });
      return { units, counts: units.map(unitCounts) };
    },
    count: async (units) => units.map(unitCounts),
  };
}

interface Entry {
  path: string;
  size: number;
}

export interface Listing {
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

const GITHUB_API = "https://api.github.com";

async function getJSON<T>(url: string): Promise<T> {
  let r: Response;
  try {
    r = url.startsWith(GITHUB_API) ? await githubApi(url.slice(GITHUB_API.length)) : await fetch(url);
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
export async function listFiles({ owner, name, ref }: RepoRef, signal: AbortSignal | null = null): Promise<Listing> {
  const candidates = refCandidates(ref);
  const stopIfCancelled = () => {
    if (signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
  };
  try {
    for (const [branch, scope] of candidates) {
      stopIfCancelled();
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
      stopIfCancelled();
      let r: Response;
      try {
        r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${name}@${encodePath(branch)}?structure=flat`, { signal: signal ?? undefined });
      } catch {
        stopIfCancelled();
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

type Parsed = { units: Unit[]; counts: TermCounts[] };

/**
 * Parse results of each selected file, kept in snapshot order (files by path, each file's units
 * in source order, as in Odin's Python index, so ties break the same way), with a partial
 * snapshot offered every few seconds of a long load.
 */
class Collector {
  readonly files: Entry[];
  readonly signal: AbortSignal | null;
  readonly perFile: (Parsed | undefined)[];
  private readonly listing: Listing;
  private readonly progress: Progress;
  private readonly partial?: Partial;
  private readonly byPath: number[];
  private lastPartial = performance.now();
  done = 0;
  failed = 0;
  unparsed = 0;

  constructor(files: Entry[], listing: Listing, progress: Progress, signal: AbortSignal | null, partial?: Partial) {
    this.files = files;
    this.listing = listing;
    this.progress = progress;
    this.signal = signal;
    this.partial = partial;
    this.perFile = new Array(files.length);
    this.byPath = files.map((f, i) => [f.path, i] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, i]) => i);
  }

  gather(): Parsed {
    const units: Unit[] = [];
    const counts: TermCounts[] = [];
    for (const i of this.byPath) {
      const r = this.perFile[i];
      if (r) {
        units.push(...r.units);
        counts.push(...r.counts);
      }
    }
    return { units, counts };
  }

  /** Parse one file's text; `null` means it could not be downloaded. */
  async add(i: number, text: string | null, parsing: Parsing): Promise<void> {
    if (text == null) this.failed++;
    else {
      try {
        this.perFile[i] = await parsing.parse(this.files[i].path, text);
      } catch {
        this.unparsed++; // one unparseable file should never sink the whole repository
      }
    }
    this.done++;
    if (this.signal?.aborted) return; // no progress reports after a cancel
    const n = this.files.length;
    if (this.done % 10 === 0 || this.done === n) this.progress("Downloading and parsing", this.done, n);
    if (this.partial && this.done < n && performance.now() - this.lastPartial > PARTIAL_EVERY_MS) {
      this.lastPartial = performance.now();
      const so = this.gather();
      const where = { repo: `${this.listing.owner}/${this.listing.name}`, branch: this.listing.branch, scope: this.listing.scope };
      if (so.units.length) this.partial(so.units, so.counts, this.done, n, where);
    }
  }

  notes(notes: string[]): void {
    if (this.failed) notes.push(`${this.failed} file${this.failed > 1 ? "s" : ""} could not be downloaded.`);
    if (this.unparsed) notes.push(`${this.unparsed} file${this.unparsed > 1 ? "s" : ""} could not be parsed.`);
  }
}

/** One request per file, sixteen at a time. `only` limits it to some files (after an archive). */
async function downloadFiles(c: Collector, parsing: Parsing, listing: Listing, only?: number[]): Promise<void> {
  const todo = only ?? c.files.map((_, i) => i);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < todo.length) {
      if (c.signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
      const i = todo[next++];
      await c.add(i, await fetchText(listing.owner, listing.name, listing.branch, c.files[i].path), parsing);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, todo.length) }, worker));
}

/**
 * The whole repository as one .tar.gz through a CORS relay: seconds instead of a request per
 * file. Files are parsed on the parser threads while the archive is still streaming. Returns
 * the files it did not deliver, so the caller can fetch those one by one.
 */
async function downloadArchive(c: Collector, parsing: Parsing, url: string): Promise<number[]> {
  const index = new Map(c.files.map((f, i) => [f.path, i]));
  const seen = new Set<number>();
  let inFlight: Promise<void>[] = [];
  try {
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`archive: HTTP ${r.status}`);
    const decoder = new TextDecoder();
    for await (const f of untar(r.body, (p) => index.has(p))) {
      if (c.signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
      const i = index.get(f.path)!;
      seen.add(i);
      inFlight.push(c.add(i, decoder.decode(f.data), parsing));
      if (inFlight.length >= 8 * parsing.threads) {
        await Promise.all(inFlight);
        inFlight = [];
      }
    }
    await Promise.all(inFlight);
  } catch (err) {
    await Promise.allSettled(inFlight); // parses already started finish before anything is gathered
    if (err instanceof LoadError) throw err;
    // Relay down or archive cut short: whatever is missing comes the slow way.
  }
  return c.files.map((_, i) => i).filter((i) => !seen.has(i));
}

interface LoadOptions {
  includeTests: boolean;
  progress: Progress;
  cache: RepoCache | null;
  signal: AbortSignal | null;
  partial?: Partial;
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function readArchive(
  parsing: Parsing, owner: string, name: string, branch: string, scope: string | null, url: string, options: LoadOptions,
): Promise<LoadedRepo | "missing" | null> {
  const { includeTests, progress, cache, signal, partial } = options;
  let response: Response;
  try {
    response = await fetch(url, { signal: signal ?? undefined });
  } catch {
    if (signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
    return null;
  }
  if (response.status === 404) return "missing";
  if (!response.ok || !response.body) return null;

  const repo = `${owner}/${name}`;
  const folder = scope ? `${scope.replace(/\/+$/, "")}/` : "";
  const wanted = (path: string) => /\.py$/i.test(path) && !SKIP_DIR.test(path) && path.startsWith(folder);
  const decoder = new TextDecoder();
  const parsed = new Map<string, Parsed>();
  const held: { path: string; text: string; size: number }[] = [];
  const started = performance.now();
  let commit: string | null = null;
  let key: string | null = null;
  let cached: Unit[] | undefined;
  let eligible = 0;
  let oversized = 0;
  let unparsed = 0;
  let kept = 0;
  let bytes = 0;
  let heldBytes = 0;
  let done = 0;
  let lastPartial = performance.now();
  let inFlight: Promise<void>[] = [];

  const gather = (): Parsed => {
    const units: Unit[] = [];
    const counts: TermCounts[] = [];
    for (const path of [...parsed.keys()].sort(byPath)) {
      const result = parsed.get(path)!;
      units.push(...result.units);
      counts.push(...result.counts);
    }
    return { units, counts };
  };
  const admit = (size: number) => kept < LIMITS.maxFiles && bytes + size <= LIMITS.maxBytes;
  const parse = async (path: string, text: string): Promise<void> => {
    try {
      parsed.set(path, await parsing.parse(path, text));
    } catch {
      unparsed++;
    }
    done++;
    if (signal?.aborted) return;
    if (done % 10 === 0) progress("Downloading and parsing", done, 0);
    if (partial && performance.now() - lastPartial > PARTIAL_EVERY_MS) {
      lastPartial = performance.now();
      const soFar = gather();
      if (soFar.units.length) partial(soFar.units, soFar.counts, done, 0, { repo, branch, scope });
    }
  };
  const keep = (path: string, text: string, size: number) => {
    kept++;
    bytes += size;
    inFlight.push(parse(path, text));
  };

  progress("Downloading and parsing", 0, 0);
  try {
    const files = untar(response.body, wanted, async (hash) => {
      commit = hash;
      key = `v3|${repo}@commit:${hash}|${scope ?? ""}|${includeTests ? "tests" : "src"}`;
      cached = cache ? await cache.get(key) : undefined;
      return !cached;
    });
    for await (const file of files) {
      if (signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
      if (!includeTests && isTestPath(file.path)) continue;
      const size = file.data.length;
      if (size > LIMITS.maxFileBytes) {
        oversized++;
        continue;
      }
      eligible++;
      if (SECONDARY.test(file.path)) {
        if (heldBytes + size <= LIMITS.maxBytes) {
          held.push({ path: file.path, text: decoder.decode(file.data), size });
          heldBytes += size;
        }
        continue;
      }
      if (!admit(size)) continue;
      keep(file.path, decoder.decode(file.data), size);
      if (inFlight.length >= 8 * parsing.threads) {
        await Promise.all(inFlight);
        inFlight = [];
      }
    }
    for (const file of held.sort((a, b) => byPath(a.path, b.path))) if (admit(file.size)) keep(file.path, file.text, file.size);
    await Promise.all(inFlight);
  } catch (err) {
    await Promise.allSettled(inFlight);
    if (err instanceof LoadError) throw err;
    if (signal?.aborted) throw new LoadError("Loading cancelled.", { cancelled: true });
    return null;
  }

  const sha = commit ? `commit:${commit}` : null;
  if (cached) {
    progress("Building the index", 0, 1);
    const counts = await parsing.count(cached);
    const loaded = performance.now();
    const index = new BM25(cached, { counts });
    return {
      repo, branch, scope, via: "archive", sha, files: new Set(cached.map((u) => u.path)).size, units: cached, index,
      notes: [], fromCache: true, timings: { loadMs: loaded - started, indexMs: performance.now() - loaded },
    };
  }
  if (!eligible) return null;
  const { units, counts } = gather();
  if (!units.length) throw new LoadError("These Python files contain no functions or classes to search.");
  const notes: string[] = [];
  if (oversized) notes.push(`Skipped ${oversized} Python file${oversized > 1 ? "s" : ""} over 1 MB (usually generated code).`);
  if (kept < eligible) {
    notes.push(`Indexed ${kept.toLocaleString()} of ${eligible.toLocaleString()} Python files to stay within browser limits; docs, examples and vendored code went first.`);
  }
  if (unparsed) notes.push(`${unparsed} file${unparsed > 1 ? "s" : ""} could not be parsed.`);
  if (key && cache) await cache.put(key, units);
  progress("Building the index", 0, 1);
  const loaded = performance.now();
  const index = new BM25(units, { counts });
  return {
    repo, branch, scope, via: "archive", sha, files: new Set(units.map((u) => u.path)).size, units, index, notes, fromCache: false,
    timings: { loadMs: loaded - started, indexMs: performance.now() - loaded },
  };
}

async function loadFromArchive(
  parsing: Parsing, ref: RepoRef, archive: (owner: string, name: string, ref: string) => string, options: LoadOptions,
): Promise<LoadedRepo | null> {
  for (const [branch, scope] of refCandidates(ref.ref)) {
    const loaded = await readArchive(parsing, ref.owner, ref.name, branch, scope, archive(ref.owner, ref.name, branch), options);
    if (loaded !== "missing") return loaded;
  }
  return null;
}

/** Download, parse and index a repository; a revisit of the same snapshot hits `cache`. */
export async function loadRepo(
  parsing: Parsing, input: string,
  { includeTests = false, progress = () => {}, cache = null, signal = null, partial, archive }:
    {
      includeTests?: boolean; progress?: Progress; cache?: RepoCache | null; signal?: AbortSignal | null; partial?: Partial;
      /** URL of the repository's .tar.gz through a CORS relay, if one is configured. */
      archive?: (owner: string, name: string, ref: string) => string;
    } = {},
): Promise<LoadedRepo> {
  const ref = parseRepo(input);
  if (archive) {
    const loaded = await loadFromArchive(parsing, ref, archive, { includeTests, progress, cache, signal, partial });
    if (loaded) return loaded;
  }
  progress("Listing files", 0, 1);
  const refKey = `${ref.owner}/${ref.name}@${ref.ref ?? ""}`.toLowerCase();
  let listing = await cache?.getListing?.(refKey);
  if (!listing) {
    listing = await listFiles(ref, signal);
    void cache?.putListing?.(refKey, listing);
  }
  const notes: string[] = [];
  if (listing.truncated) notes.push("GitHub truncated the file list for this very large repository; some files are missing.");
  const kept = selectFiles(listing, includeTests, notes);

  const repo = `${listing.owner}/${listing.name}`;
  const key = listing.sha ? `v3|${repo}@${listing.sha}|${listing.scope ?? ""}|${includeTests ? "tests" : "src"}` : null;
  const t0 = performance.now();
  let loaded = key && cache ? await cache.get(key) : undefined;
  const fromCache = !!loaded;
  let counts: TermCounts[];
  if (loaded) {
    progress("Building the index", 0, 1);
    counts = await parsing.count(loaded);
  } else {
    const c = new Collector(kept, listing, progress, signal, partial);
    const rest = archive ? await downloadArchive(c, parsing, archive(listing.owner, listing.name, listing.branch)) : undefined;
    if (!rest || rest.length) await downloadFiles(c, parsing, listing, rest);
    c.notes(notes);
    ({ units: loaded, counts } = c.gather());
    if (!loaded.length) throw new LoadError("These Python files contain no functions or classes to search.");
    if (key && cache) await cache.put(key, loaded);
    progress("Building the index", 0, 1);
  }
  const t1 = performance.now();
  const index = new BM25(loaded, { counts });
  return {
    repo, branch: listing.branch, scope: listing.scope, via: listing.via, sha: listing.sha,
    files: new Set(loaded.map((u) => u.path)).size, units: loaded, index, notes, fromCache,
    timings: { loadMs: t1 - t0, indexMs: performance.now() - t1 },
  };
}
