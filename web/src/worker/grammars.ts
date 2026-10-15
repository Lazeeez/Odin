import treeSitterWasm from "web-tree-sitter/tree-sitter.wasm?url";
import type { Parser } from "web-tree-sitter";
import go from "../assets/tree-sitter-go.wasm?url";
import java from "../assets/tree-sitter-java.wasm?url";
import javascript from "../assets/tree-sitter-javascript.wasm?url";
import python from "../assets/tree-sitter-python.wasm?url";
import rust from "../assets/tree-sitter-rust.wasm?url";
import tsx from "../assets/tree-sitter-tsx.wasm?url";
import typescript from "../assets/tree-sitter-typescript.wasm?url";
import { createParser } from "../engine/chunk.ts";
import type { Lang } from "../engine/languages-rules.ts";

const GRAMMARS: Record<Lang, string> = { python, javascript, typescript, tsx, go, java, rust };
const parsers = new Map<Lang, Promise<Parser>>();

export function parserFor(lang: Lang): Promise<Parser> {
  let parser = parsers.get(lang);
  if (!parser) {
    parser = createParser(treeSitterWasm, GRAMMARS[lang]);
    parser.catch(() => parsers.delete(lang));
    parsers.set(lang, parser);
  }
  return parser;
}
