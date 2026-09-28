// Every ranking stage's candidates and features from the website's TypeScript ranker; input
// {units, queries, model, sims} as JSON on stdin (sims: per query, similarity of every unit to
// the issue and to its title). Prints, per query, {instant, semantic, files}: [id, features,
// score] rows in index order. Used by tests/test_site_engine.py.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const load = (p) => import(pathToFileURL(resolve(web, p)).href);
const { BM25 } = await load("src/engine/bm25.ts");
const { rankFiles, rankUnits, signals } = await load("src/engine/rank.ts");

const { units, queries, model, sims } = JSON.parse(readFileSync(0, "utf8"));
const index = new BM25(units.map((u) => ({ ...u, id: `${u.path}::${u.qualname}` })));
const rows = (cands) => cands.sort((a, b) => a.row - b.row).map((c) => [c.unit?.id ?? c.path, Array.from(c.x), c.score]);
const out = queries.map((q, i) => {
  const instant = rankUnits(index, model, model.instant, signals(index, q));
  const sim = { issue: Float32Array.from(sims[i][0]), title: Float32Array.from(sims[i][1]) };
  const sig = signals(index, q, sim);
  const semantic = rankUnits(index, model, model.semantic, sig);
  const files = rankFiles(index, model.file, model.semantic, sig, semantic);
  return { instant: rows(instant.candidates), semantic: rows([...semantic.candidates]), files: rows(files) };
});
process.stdout.write(JSON.stringify(out));
