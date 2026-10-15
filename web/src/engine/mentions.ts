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
const SRC_PATH = /[\w./\\-]+\.(?:py|jsx?|mjs|cjs|tsx?|mts|cts|go|java|rs)\b/g;
const JS_FRAME = /^[ \t]*at (?:async )?(?:new )?(?:([^\s()]+) )?\(?([^\s()]+?):\d+:\d+\)?[ \t]*$/gm;
const FIREFOX_FRAME = /^[ \t]*([\w$.<>/]*)@([^\s@]+?):\d+:\d+[ \t]*$/gm;
const JAVA_FRAME = /^[ \t]*at ((?:[\w$]+\.)*)([\w$]+)\.([\w$<>]+)\(([\w$]+\.(?:java|kt)):\d+\)/gm;
const GO_FRAME = /^([\w./*()\-]+)\([^()\n]*\)[ \t]*\n[ \t]+(\S+\.go):\d+/gm;
const RUST_FRAME = /^[ \t]*\d+:[ \t]+(\S+)[ \t]*\n[ \t]+at (\S+\.rs):\d+:\d+/gm;
const RUST_PANIC = /panicked at ([^\s:]+\.rs):\d+:\d+/g;
const EXTENSION = /\.(?:py|jsx?|mjs|cjs|tsx?|mts|cts|go|java|rs)$/;

function cleanPath(path: string): string {
  let p = path.replaceAll("\\", "/");
  for (const prefix of ["file://", "webpack://", "webpack-internal:///"]) if (p.startsWith(prefix)) p = p.slice(prefix.length);
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function lastName(name: string, separators = "."): string {
  let n = name;
  for (const sep of separators) {
    const i = n.lastIndexOf(sep);
    if (i >= 0) n = n.slice(i + 1);
  }
  return !n || n.includes("<") || n.includes("{") ? "" : n;
}

function otherFrames(text: string): [string, string][] {
  const groups: [string, string][][] = [
    Array.from(text.matchAll(JS_FRAME)).filter((m) => !m[2].endsWith(".rs")).map((m): [string, string] => [cleanPath(m[2]), lastName(m[1] ?? "")]),
    Array.from(text.matchAll(FIREFOX_FRAME), (m): [string, string] => [cleanPath(m[2]), lastName(m[1] ?? "")]),
    Array.from(text.matchAll(JAVA_FRAME), (m): [string, string] => [m[1].replaceAll(".", "/") + m[4], m[3]]),
    Array.from(text.matchAll(GO_FRAME), (m): [string, string] => [cleanPath(m[2]), lastName(m[1].replaceAll("(*", "").replaceAll(")", ""))]),
    Array.from(text.matchAll(RUST_FRAME), (m): [string, string] => [cleanPath(m[2]), lastName(m[1], ":")]),
  ];
  const frames = groups.flatMap((g) => [...g].reverse());
  for (const m of text.matchAll(RUST_PANIC)) {
    const path = cleanPath(m[1]);
    if (!frames.length || frames[frames.length - 1][0] !== path) frames.push([path, ""]);
  }
  return frames;
}

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
  multilang: boolean;
}

const all = (re: RegExp, text: string): string[] => Array.from(text.matchAll(re), (m) => m[0]);

export function parseMentions(text: string, multilang = false): Mentions {
  const frames = Array.from(text.matchAll(FRAME), (m): [string, string] => [m[1].replaceAll("\\", "/"), m[2]]);
  if (multilang) frames.push(...otherFrames(text));
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
    frameNames: new Set(frames.map(([, n]) => n).filter((n) => n)),
    framePaths: frames.map(([p]) => p),
    pyPaths: all(multilang ? SRC_PATH : PY_PATH, text).map((p) => p.replaceAll("\\", "/")),
    lastFrame: frames.at(-1) ?? null,
    multilang,
  };
}

/** Does a path from the issue (often absolute, from site-packages) name this repo file? */
export const pathMatches = (mentioned: string, repoPath: string, multilang = false): boolean =>
  mentioned === repoPath || mentioned.endsWith(`/${repoPath}`) || (multilang && mentioned.includes("/") && repoPath.endsWith(`/${mentioned}`));

/** django/db/models/query.py -> django.db.models.query (src/ layouts keep working). */
export function moduleName(repoPath: string, multilang = false): string {
  if (multilang && !repoPath.endsWith(".py")) {
    let path = repoPath.replace(EXTENSION, "");
    if (path.endsWith("/index")) path = path.slice(0, -"/index".length);
    for (const root of ["src/main/java/", "src/test/java/", "src/main/kotlin/"]) {
      const i = path.indexOf(root);
      if (i >= 0) path = path.slice(i + root.length);
    }
    const mod = path.replaceAll("/", ".");
    return mod.startsWith("src.") ? mod.slice(4) : mod;
  }
  const mod = repoPath.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
  return mod.startsWith("src.") ? mod.slice(4) : mod;
}

/** (title, code): an issue's first line, and everything quoted as code. */
export function issueFields(text: string): [string, string] {
  // Python's str.splitlines() boundaries, so the title matches the one the model was trained on.
  const title = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).find((line) => line.trim()) ?? "";
  return [title, all(CODE, text).join(" ")];
}
