// Chunk Python files (paths on stdin) with the website's TypeScript engine; print
// {path: units} as JSON. Node 22.18+ runs the .ts source directly (type stripping), so
// this tests the exact code the site ships. Used by tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const { chunkFile, createParser } = await import(pathToFileURL(resolve(web, "src/engine/chunk.ts")).href);

const parser = await createParser(
  resolve(web, "node_modules/web-tree-sitter/tree-sitter.wasm"),
  resolve(web, "src/assets/tree-sitter-python.wasm"),
);
const out = {};
// Paths come on stdin, one per line: command lines are too short for large file sets.
const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
for (const path of paths) out[path] = chunkFile(parser, readFileSync(path, "utf8"));
process.stdout.write(JSON.stringify(out));
