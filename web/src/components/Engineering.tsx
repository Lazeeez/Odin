import { inlineCode } from "../lib/format.ts";

const CARDS: [string, string, string][] = [
  ["377×", "faster git reads", "One long-lived `git cat-file --batch` process instead of two subprocesses per file."],
  ["36.7×", "fewer embeddings", "6.79M function slots across 698 commits, 185k distinct: each function is embedded once, keyed by content hash."],
  ["90%", "of files never re-parsed", "Parsing is memoized by git blob id; a persistent cache keyed by the parser's own source makes re-runs 3.4× faster."],
  ["4.8×", "embedding throughput", "Length-sorted, token-budgeted batches: padding waste falls from 79% to 2%."],
  ["~10 ms", "git-history features", "The commit DAG lives in memory, replacing a 100 ms `git rev-list` per query with an identical walk."],
  ["0", "Python/browser mismatches", "The browser's chunker, BM25 and ranker features are tested against the Python engine, value for value."],
];

export function Highlights() {
  return (
    <div class="cards">
      {CARDS.map(([big, t, p]) => (
        <div class="ecard" key={t}>
          <div class="big">{big}</div>
          <div class="t">{t}</div>
          <p dangerouslySetInnerHTML={{ __html: inlineCode(p) }} />
        </div>
      ))}
    </div>
  );
}

export function Lessons() {
  return (
    <ul class="plain-list">
      <li><b>Call-graph expansion:</b> tuned on a dev set, +0.3 points, not significant. Only 15% of misses were one call away from a top hit, so the ceiling was low.</li>
      <li><b>Zero-shot LLM rerankers:</b> an off-the-shelf 0.6B and a 4-bit 4B model both matched, not beat, the existing ranking. Fine-tuning on in-domain hard negatives is what made the reranker work.</li>
      <li><b>A tiny reranker in the browser:</b> a fine-tuned 22M-parameter cross-encoder added 0.5 points, within noise, for a 23 MB download. It was left out.</li>
      <li><b>ANN search (HNSW):</b> building the index costs ~650 ms to save ~0.05 ms per query. Every commit answers one query, so exact search is faster and lossless.</li>
      <li><b>Hyperparameter tuning:</b> every LightGBM variant tried landed within noise of the defaults, a plateau worth knowing about.</li>
    </ul>
  );
}
