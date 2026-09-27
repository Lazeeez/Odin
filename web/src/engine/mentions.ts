// Port of odin/rank/mentions.py: what an issue explicitly names. Reporters paste tracebacks,
// quote method names in backticks and cite module paths; exact matches on these are the
// strongest, cheapest localization evidence there is.

// Python traceback frames: File ".../django/db/models/query.py", line 123, in filter
const FRAME = /File "([^"]+)", line \d+, in ([A-Za-z_<][\w<>]*)/g;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
const DOTTED = /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g;
const PY_PATH = /[\w./\\-]+\.py\b/g;
const FENCE = /```[\s\S]*?```/g;
const INLINE = /`[^`\n]+`/g;
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

export interface Mentions {
  /** Every identifier, case-sensitive, with its count. */
  idents: Map<string, number>;
  /** Identifiers inside code fences or backticks. */
  codeIdents: Set<string>;
  /** a.b.c names and every contiguous sub-path of them. */
  dotted: Set<string>;
  frameNames: Set<string>;
  framePaths: string[];
  pyPaths: string[];
  /** The innermost frame (path, name): where it blew up. */
  lastFrame: [string, string] | null;
}

const all = (re: RegExp, text: string): string[] => Array.from(text.matchAll(re), (m) => m[0]);

export function parseMentions(text: string): Mentions {
  const frames = Array.from(text.matchAll(FRAME), (m): [string, string] => [m[1].replaceAll("\\", "/"), m[2]]);
  const code = [...all(FENCE, text), ...all(INLINE, text)].join(" ");
  const dotted = new Set<string>();
  for (const d of all(DOTTED, text)) {
    const parts = d.split(".");
    for (let i = 0; i < parts.length; i++) for (let j = i + 2; j <= parts.length; j++) dotted.add(parts.slice(i, j).join("."));
  }
  const idents = new Map<string, number>();
  for (const id of all(IDENT, text)) idents.set(id, (idents.get(id) ?? 0) + 1);
  return {
    idents,
    codeIdents: new Set(all(IDENT, code)),
    dotted,
    frameNames: new Set(frames.map(([, n]) => n)),
    framePaths: frames.map(([p]) => p),
    pyPaths: all(PY_PATH, text).map((p) => p.replaceAll("\\", "/")),
    lastFrame: frames.at(-1) ?? null,
  };
}

/** Does a path from the issue (often absolute, from site-packages) name this repo file? */
export const pathMatches = (mentioned: string, repoPath: string): boolean =>
  mentioned === repoPath || mentioned.endsWith(`/${repoPath}`);

/** django/db/models/query.py -> django.db.models.query (src/ layouts keep working). */
export function moduleName(repoPath: string): string {
  const mod = repoPath.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
  return mod.startsWith("src.") ? mod.slice(4) : mod;
}

/** (title, code): an issue's first line, and everything quoted as code. */
export function issueFields(text: string): [string, string] {
  // Python's str.splitlines() boundaries, so the title matches the one the model was trained on.
  const title = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).find((line) => line.trim()) ?? "";
  return [title, all(CODE, text).join(" ")];
}
