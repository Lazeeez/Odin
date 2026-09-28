import type { Summary } from "../lib/data.ts";
import { inlineCode, pct } from "../lib/format.ts";

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
      {CARDS.map(([big, t, p], i) => (
        <div class="ecard frame reveal" key={t} style={{ "--d": `${(i % 3) * 0.08}s` }}>
          <div class="big">{big}</div>
          <div class="t">{t}</div>
          <p dangerouslySetInnerHTML={{ __html: inlineCode(p) }} />
        </div>
      ))}
    </div>
  );
}

type Tried = [title: string, body: string, result: string];

/** Pipeline gains from the evaluation itself, so the page and the data can't disagree. */
const PIPELINE_WINS: [from: string, to: string, title: string, body: string][] = [
  ["bm25-naive", "bm25-code-notests", "Splitting code names into words",
    "Identifier-aware BM25: snake_case and camelCase names are indexed as their parts and whole, and test files are excluded, so prose like “query set” matches `get_queryset`."],
  ["bm25-code-notests", "hybrid-notests", "Adding meaning to keywords",
    "Hybrid retrieval: BM25 fused with dense scores from a code embedding model (jina-code-0.5b), with fusion weights tuned on a separate dev set."],
  ["hybrid-notests", "ltr-notests", "Learning from past bugs",
    "LambdaMART over mention, traceback, git-history and similar-past-fix signals, trained on 1,941 other SWE-bench issues and re-ranking the top candidates."],
  ["ltr-notests", "ltr-ce-notests", "A language model as the final judge",
    "A Qwen3 cross-encoder fine-tuned on in-domain hard negatives reads the issue and each of the top 20 functions together; its score is blended with the ranker's."],
];

const BROWSER_WINS: Tried[] = [
  ["Training on projects it will never see",
    "The browser rankers were retrained on 5,115 issues from 131 projects with project-grouped cross-validation, then tested on 30 projects held out entirely (747 bugs).",
    "hit@10 0.759 → 0.772 (p = 0.049); file hit@10 0.925 → 0.944 (p = 0.005)"],
  ["Semantic search small enough for a browser",
    "Model2Vec potion-code-16M static embeddings, int8 with per-row scales (16.8 MB): no neural network at encode time, ~3,300–4,200 functions/s per thread. The WordPiece port is token-identical to the Rust tokenizer.",
    "CV hit@10 0.748 → 0.766 over the instant ranker"],
  ["One download instead of thousands",
    "An optional Cloudflare Worker relays GitHub's .tar.gz of the repository, streamed and unpacked in the browser, instead of one request per file.",
    "transformers 57 s → 5.0 s; Home Assistant 102 s → 4.2 s"],
  ["Search while it loads",
    "Parsing and term counting run on up to four worker threads, and a partial index is published every 2.5 s during long loads.",
    "transformers searchable after 3.4 s"],
];

function TriedList({ items, ok }: { items: Tried[]; ok: boolean }) {
  return (
    <ul class="tried">
      {items.map(([title, body, result], i) => (
        <li key={title} class="frame reveal" style={{ "--d": `${(i % 2) * 0.08}s` }}>
          <span class={`tried-mark${ok ? " ok" : ""}`} aria-label={ok ? "worked" : "didn't work"}>{ok ? "✓" : "✗"}</span>
          <div>
            <h3>{title}</h3>
            <p dangerouslySetInnerHTML={{ __html: inlineCode(body) }} />
            <p class="tried-result">{result}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Worked({ summary }: { summary: Summary | null }) {
  const at = (id: string) => summary?.stages.find((x) => x.level === "function" && x.id === id);
  const pipeline: Tried[] = PIPELINE_WINS.map(([from, to, title, body]) => {
    const a = at(from);
    const b = at(to);
    const sig = summary?.significance[`function:${from}->${to}`]?.["recall@10"];
    const result = a && b
      ? `hit@10 ${pct(a["hit@10"])} → ${pct(b["hit@10"])}${sig ? ` · recall@10 +${sig.delta.toFixed(3)}, p ${sig.p < 0.001 ? "< 0.001" : `= ${sig.p.toFixed(3)}`}` : ""}`
      : "";
    return [title, body, result];
  });
  return <TriedList items={[...pipeline, ...BROWSER_WINS]} ok />;
}

const FAILED: Tried[] = [
  ["Following the call graph",
    "Expanding the top hits to their callers and callees, tuned on a dev set. Only 15% of misses were one call away from a top hit, so the ceiling was low.",
    "+0.3 points, not significant"],
  ["Off-the-shelf language models",
    "Zero-shot rerankers: an off-the-shelf 0.6B model and a 4-bit 4B model. Fine-tuning on in-domain hard negatives is what made the reranker work.",
    "matched, did not beat, the existing ranking"],
  ["A tiny reranker in the browser",
    "A fine-tuned 22M-parameter cross-encoder over the top candidates, running in the tab.",
    "+0.5 points, within noise, for a 23 MB download: left out"],
  ["Approximate nearest neighbours",
    "An HNSW index for the embedding search. Every commit answers one query, so building the index never pays off.",
    "~650 ms to build to save ~0.05 ms per query"],
  ["Hyperparameter tuning",
    "LightGBM variants over learning rate, leaves, rounds and objectives.",
    "every variant within noise of the defaults"],
  ["A learned query projection",
    "An InfoNCE-trained linear map on the issue's static embedding, trained on four folds of projects and tested on the fifth, to pull issues closer to the code that fixes them.",
    "semantic-only MRR 0.287 → 0.220 on held-out projects: worse in every fold"],
  ["One distilled reranker instead of two",
    "The two fine-tuned cross-encoders distilled into one (soft labels from the ensemble, KL loss). Better on validation (MRR 0.634 vs 0.623), but not on SWE-bench Lite.",
    "file top-1 0.690 → 0.660 (p = 0.027); function MRR 0.560 → 0.545, not significant: kept the ensemble"],
  ["More training data, on the old benchmark",
    "The browser rankers retrained on 131 projects improved on unseen projects but not on SWE-bench Lite's 12 familiar ones.",
    "Lite hit@10 0.701 → 0.691, not significant"],
];

export function Lessons() {
  return <TriedList items={FAILED} ok={false} />;
}
