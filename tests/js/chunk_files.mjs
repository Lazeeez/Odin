// Chunk source files (paths on stdin) with the website's TypeScript engine; print
// {path: units} as JSON. Node 22.18+ runs the .ts source directly (type stripping), so
// this tests the exact code the site ships. Used by tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const { chunkFile, createParser } = await import(pathToFileURL(resolve(web, "src/engine/chunk.ts")).href);
const { languageOf } = await import(pathToFileURL(resolve(web, "src/engine/languages-rules.ts")).href);

const runtime = resolve(web, "node_modules/web-tree-sitter/tree-sitter.wasm");
const parsers = new Map();
const parserFor = (lang) => {
  if (!parsers.has(lang)) parsers.set(lang, createParser(runtime, resolve(web, `src/assets/tree-sitter-${lang}.wasm`)));
  return parsers.get(lang);
};
const out = {};
// Paths come on stdin, one per line: command lines are too short for large file sets.
const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
for (const path of paths) {
  const lang = languageOf(path) ?? "python";
  out[path] = chunkFile(await parserFor(lang), readFileSync(path, "utf8"), lang);
}
process.stdout.write(JSON.stringify(out));
