// Python syntax highlighting plus <mark> on identifiers that match the query.
// Output is HTML built only from escaped text, so repository code can never inject markup.
import { IDENT, expand, tokenize } from "../engine/tokenize.ts";
import { escapeHtml } from "./format.ts";

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls".split(
    " ",
  ),
);
const TOKEN =
  /(#[^\n]*)|([rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'))|(@[A-Za-z_][\w.]*)|\b(\d[\d_]*(?:\.\d+)?)\b|([A-Za-z_][A-Za-z0-9_]*)/g;

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

export function highlightPython(text: string, terms: ReadonlySet<string>): string {
  let out = "";
  let last = 0;
  let prev = "";
  for (const m of text.matchAll(TOKEN)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, comment, str, decorator, num, word] = m;
    if (word) {
      const cls = KEYWORDS.has(word) ? "tk-kw" : prev === "def" || prev === "class" ? "tk-def" : "";
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

/** Which query terms a unit contains, and how often: the "why this result" line. */
export function matchedTerms(text: string, terms: readonly string[]): [string, number][] {
  const wanted = new Set(terms);
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) if (wanted.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}
