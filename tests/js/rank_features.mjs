// Stage-1 candidates and features from the website's TypeScript ranker; input {units, queries,
// model} as JSON on stdin. Prints, per query, [[id, features, score], ...] in index order.
// Used by tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const load = (p) => import(pathToFileURL(resolve(web, p)).href);
const { BM25 } = await load("src/engine/bm25.ts");
const { rankStage1 } = await load("src/engine/rank.ts");

const { units, queries, model } = JSON.parse(readFileSync(0, "utf8"));
const index = new BM25(units.map((u) => ({ ...u, id: `${u.path}::${u.qualname}` })));
const out = queries.map((q) =>
  rankStage1(index, model, q)
    .candidates.sort((a, b) => a.row - b.row)
    .map((c) => [c.unit.id, Array.from(c.x), c.score]),
);
process.stdout.write(JSON.stringify(out));
