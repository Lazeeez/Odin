// Port of odin/search/tokenize.py. tests/test_site_engine.py checks it against Python.

const STOP = new Set(
  `a an and are as at be but by for from has have if in into is it its of on or so that the
  their then there these this to was were will with not no can do does i we you when which
  self cls def return none true false import pass else elif try except raise lambda class`.split(/\s+/),
);

export const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
// HTTPServerError -> HTTP, Server, Error; parse2d -> parse, 2 (single letters are dropped).
const SUBWORD = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;
const cache = new Map<string, readonly string[]>();

/** Tokens for one identifier: its parts, plus the whole name when it has several parts. */
export function expand(ident: string): readonly string[] {
  const hit = cache.get(ident);
  if (hit) return hit;
  const parts = ident
    .split("_")
    .flatMap((piece) => piece.match(SUBWORD) ?? [])
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 1 && !STOP.has(p));
  const whole = ident.toLowerCase().replace(/^_+|_+$/g, "");
  let out: readonly string[];
  if (parts.length > 1 || parts.length === 0) out = whole && !STOP.has(whole) ? [whole, ...parts] : parts;
  else out = parts;
  cache.set(ident, out);
  return out;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IDENT)) out.push(...expand(m[0]));
  return out;
}

/** Path components as searchable words: django/db/models/query.py -> "django db models query". */
export const pathText = (path: string): string => {
  const stem = path.endsWith(".py") || !path.includes(".") ? path.replace(/\.py$/, "") : path.slice(0, path.lastIndexOf("."));
  return stem.split(/[/._-]+/).join(" ");
};
