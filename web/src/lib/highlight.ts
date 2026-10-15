// Syntax highlighting (Python, and C-style rules for the other languages) plus <mark> on identifiers that match the query.
// Output is HTML built only from escaped text, so repository code can never inject markup.
import { IDENT, expand, tokenize } from "../engine/tokenize.ts";
import { escapeHtml } from "./format.ts";

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls".split(
    " ",
  ),
);
const PY_TOKEN =
  /(#[^\n]*)|([rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'))|(@[A-Za-z_][\w.]*)|\b(\d[\d_]*(?:\.\d+)?)\b|([A-Za-z_][A-Za-z0-9_]*)/g;
const C_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(@[A-Za-z_][\w.]*)|\b(\d[\d_]*(?:\.\d+)?)\b|([A-Za-z_$][A-Za-z0-9_$]*)/g;
const C_KEYWORDS = new Set(
  ("abstract as async await break case catch chan class const continue default defer delete do dyn else enum export extends false final finally " +
    "fn for func function go if impl implements import in instanceof interface let loop map match mod move mut new nil null package private " +
    "protected pub public readonly record return select self Self static struct super switch this throw throws trait true try type typeof " +
    "undefined use var void where while yield").split(" "),
);
const PY_DEFS = new Set(["def", "class"]);
const C_DEFS = new Set(["class", "enum", "fn", "func", "function", "impl", "interface", "struct", "trait", "type"]);

const matches = (word: string, terms: ReadonlySet<string>) => expand(word).some((t) => terms.has(t));

function markWords(s: string, terms: ReadonlySet<string>): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(IDENT)) {
    out += escapeHtml(s.slice(last, m.index));
    out += matches(m[0], terms) ? `<mark>${escapeHtml(m[0])}</mark>` : escapeHtml(m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

export function highlightCode(text: string, terms: ReadonlySet<string>, path = ""): string {
  const python = !path || /\.pyi?$/i.test(path);
  const [token, keywords, defs] = python ? [PY_TOKEN, PY_KEYWORDS, PY_DEFS] : [C_TOKEN, C_KEYWORDS, C_DEFS];
  let out = "";
  let last = 0;
  let prev = "";
  for (const m of text.matchAll(token)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, comment, str, decorator, num, word] = m;
    if (word) {
      const cls = keywords.has(word) ? "tk-kw" : defs.has(prev) ? "tk-def" : "";
      const inner = matches(word, terms) ? `<mark>${escapeHtml(word)}</mark>` : escapeHtml(word);
      out += cls ? `<span class="${cls}">${inner}</span>` : inner;
      prev = word;
      continue;
    }
    if (comment) out += `<span class="tk-com">${markWords(comment, terms)}</span>`;
    else if (str) out += `<span class="tk-str">${markWords(str, terms)}</span>`;
    else if (decorator) out += `<span class="tk-dec">${escapeHtml(decorator)}</span>`;
    else out += `<span class="tk-num">${escapeHtml(num)}</span>`;
    prev = "";
  }
  return out + escapeHtml(text.slice(last));
}

export const highlightPython = (text: string, terms: ReadonlySet<string>): string => highlightCode(text, terms);

/** Which query terms a unit contains, and how often: the "why this result" line. */
export function matchedTerms(text: string, terms: readonly string[]): [string, number][] {
  const wanted = new Set(terms);
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) if (wanted.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}
