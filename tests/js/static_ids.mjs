// WordPiece ids from the website's TypeScript tokenizer; input {vocab, unk, max, texts} on stdin.
// Used by tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const { wordPieceIds } = await import(pathToFileURL(resolve(web, "src/engine/static.ts")).href);
const { vocab, unk, pad, max, texts } = JSON.parse(readFileSync(0, "utf8"));
const map = new Map(vocab.map((t, i) => [t, i]));
process.stdout.write(JSON.stringify(texts.map((t) => wordPieceIds(t, map, unk, max, pad ?? -1))));
