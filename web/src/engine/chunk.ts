// Port of odin/parsing/python_symbols.py + odin/index/chunker.py. It must produce the
// same units as Python: tests/test_site_engine.py compares them on real code.
import { Language, Parser } from "web-tree-sitter";
import type { Node, Tree } from "web-tree-sitter";
import { type Found, type Lang, RULES } from "./languages-rules.ts";
import type { Chunk, UnitKind } from "./types.ts";

const DEFS = new Set(["function_definition", "class_definition"]);
const CONTAINERS = new Set([
  "module", "block", "if_statement", "elif_clause", "else_clause", "for_statement",
  "while_statement", "try_statement", "except_clause", "except_group_clause",
  "finally_clause", "with_statement", "match_statement", "case_clause",
]);

interface SymbolSpan {
  qualname: string;
  kind: UnitKind;
  startLine: number;
  endLine: number;
  nested: boolean;
}

function walk(node: Node, rule: (n: Node) => Found | null, out: SymbolSpan[]): void {
  type Frame = [children: Iterator<Node | null>, scope: string[], parentKind: UnitKind | null, inFunc: boolean];
  const stack: Frame[] = [[node.namedChildren[Symbol.iterator](), [], null, false]];
  while (stack.length) {
    const [children, scope, parentKind, inFunc] = stack[stack.length - 1];
    const next = children.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const child = next.value;
    if (!child) continue;
    const f = rule(child);
    if (!f) {
      stack.push([child.namedChildren[Symbol.iterator](), scope, parentKind, inFunc]);
      continue;
    }
    const qual = [...scope, f.name];
    if (!f.unit) {
      if (f.body) stack.push([f.body.namedChildren[Symbol.iterator](), qual, f.kind, inFunc]);
      continue;
    }
    let kind = f.kind as UnitKind;
    if (kind === "function" && parentKind === "class") kind = "method";
    out.push({ qualname: qual.join("."), kind, startLine: f.start.startPosition.row + 1, endLine: f.end.endPosition.row + 1, nested: inFunc });
    if (f.body) stack.push([f.body.namedChildren[Symbol.iterator](), qual, kind, inFunc || kind !== "class"]);
  }
}

export function extractSymbols(tree: Tree, lang: Lang = "python"): SymbolSpan[] {
  if (lang !== "python") {
    const out: SymbolSpan[] = [];
    walk(tree.rootNode, RULES[lang], out);
    out.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    return out;
  }
  const out: SymbolSpan[] = [];
  const stack: [Node, string[], UnitKind | null, boolean][] = [[tree.rootNode, [], null, false]];
  while (stack.length) {
    const [node, scope, parentKind, inFunc] = stack.pop()!;
    for (const child of node.children) {
      if (!child) continue;
      let target: Node | null = child;
      if (child.type === "decorated_definition") {
        target = child.childForFieldName("definition");
        if (!target) continue;
      }
      if (DEFS.has(target.type)) {
        const ident = target.childForFieldName("name");
        const qual = [...scope, ident ? ident.text : "<anonymous>"];
        const kind: UnitKind = target.type === "class_definition" ? "class" : parentKind === "class" ? "method" : "function";
        out.push({
          qualname: qual.join("."),
          kind,
          startLine: child.startPosition.row + 1,
          endLine: target.endPosition.row + 1,
          nested: inFunc,
        });
        const body = target.childForFieldName("body");
        if (body) stack.push([body, qual, kind, inFunc || kind !== "class"]);
      } else if (CONTAINERS.has(child.type)) {
        stack.push([child, scope, parentKind, inFunc]);
      }
    }
  }
  out.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  return out;
}

/** Python's str.splitlines(): a final newline does not produce an empty last line. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Split one file into units. Each unit owns the lines no inner unit claims. */
export function chunkFile(parser: Parser, source: string, lang: Lang = "python"): Chunk[] {
  const tree = parser.parse(source);
  if (!tree) return [];
  const lines = splitLines(source);
  const units = extractSymbols(tree, lang).filter((s) => !s.nested);
  tree.delete();
  const owner = new Int32Array(lines.length + 2).fill(-1);
  // Outer units come first, so inner units overwrite the lines they own.
  units.forEach((s, i) => {
    for (let ln = s.startLine; ln <= Math.min(s.endLine, lines.length); ln++) owner[ln] = i;
  });
  const owned: string[][] = units.map(() => []);
  lines.forEach((text, i) => {
    if (owner[i + 1] >= 0) owned[owner[i + 1]].push(text);
  });
  return units.map((s, i) => ({ qualname: s.qualname, kind: s.kind, line: s.startLine, text: owned[i].join("\n") }));
}

/** A Python parser. `runtimeWasm` and `grammarWasm` are URLs (browser) or file paths (Node). */
let runtime: Promise<void> | null = null;

export async function createParser(runtimeWasm: string, grammarWasm: string): Promise<Parser> {
  await (runtime ??= Parser.init({ locateFile: () => runtimeWasm }));
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammarWasm));
  return parser;
}
