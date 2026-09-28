// Static embeddings from the website's TypeScript encoder; argv[2] is a model file written by
// odin.search.static.export_browser_model, texts come as JSON on stdin. Used by
// tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const { embedText, parseStaticModel } = await import(pathToFileURL(resolve(web, "src/engine/static.ts")).href);
const buf = readFileSync(process.argv[2]);
const model = parseStaticModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const texts = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(texts.map((t) => Array.from(embedText(model, t)))));
