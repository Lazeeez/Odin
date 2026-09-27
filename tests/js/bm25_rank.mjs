// Rank units with the website's TypeScript BM25; input {units, queries} as JSON on stdin.
// Prints, per query, the top 10 as [id, score]. Used by tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const { BM25 } = await import(pathToFileURL(resolve(web, "src/engine/bm25.ts")).href);

const { units, queries } = JSON.parse(readFileSync(0, "utf8"));
const index = new BM25(units.map((u) => ({ ...u, id: `${u.path}::${u.qualname}` })));
const out = queries.map((q) => index.search(q, 10).hits.map((h) => [h.unit.id, h.score]));
process.stdout.write(JSON.stringify(out));
