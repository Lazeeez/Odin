import { useState } from "preact/hooks";
import { type Summary, stagesAt } from "../lib/data.ts";
import { fixed3, inlineCode, pct } from "../lib/format.ts";

export function Hero({ summary }: { summary: Summary | null }) {
  const fn = summary ? stagesAt(summary, "function") : [];
  const fl = summary ? stagesAt(summary, "file") : [];
  const stats = summary
    ? [
        [pct(fl.at(-1)!["hit@5"]), <>of bugs: the file to fix is in the <b>top 5</b></>],
        [pct(fn.at(-1)!["hit@10"]), <>of bugs: a function to fix is in the <b>top 10</b>, out of ~40,000</>],
        [`${(fn.at(-1)!["recall@10"] / fn[0]["recall@10"]).toFixed(1)}×`, <>improvement in function recall@10 over plain BM25</>],
      ]
    : [["–", "loading"], ["–", "loading"], ["–", "loading"]];
  return (
    <section class="hero">
      <p class="eyebrow">Bug localization · SWE-bench · evaluated on held-out real issues</p>
      <h1>Given a bug report, find the code that has to change.</h1>
      <p class="lede">
        Odin searches a repository <em>at the exact commit the bug was reported against</em>, combining code-aware keyword search,
        code embeddings, a learned ranker and a fine-tuned LLM reranker. Every number on this page is measured on 300 real GitHub
        issues the system never trained on.
      </p>
      <div class="stats">
        {stats.map(([num, label], i) => (
          <div class="stat" key={i}>
            <span class="num">{num}</span>
            <span class="lbl">{label}</span>
          </div>
        ))}
      </div>
      <div class="cta">
        <a class="btn primary" href="#try">Search a repository</a>
        <a class="btn" href="#explorer">Explore 300 real bugs</a>
      </div>
    </section>
  );
}

const FUNNEL: [string, string][] = [
  ["~40k units", "keyword scores for every function"],
  ["~40k units", "identifier-aware keyword scores, tests excluded"],
  ["~40k units", "keyword + embedding scores, fused"],
  ["~450 candidates", "LambdaMART with 42 features"],
  ["top 20–30", "fine-tuned LLM cross-encoder, blended"],
];

export function Pipeline({ summary }: { summary: Summary }) {
  const fn = stagesAt(summary, "function");
  const [stage, setStage] = useState(fn.length - 1);
  const s = fn[stage];
  const file = stagesAt(summary, "file").find((x) => x.id === s.id);
  const [pool, what] = FUNNEL[stage] ?? ["", ""];
  const lat = s.latency_ms_p50;
  return (
    <>
      <div class="pipeline" role="tablist" aria-label="Pipeline stages">
        {fn.map((x, i) => (
          <button key={x.id} type="button" role="tab" aria-selected={i === stage} class={`stage${i === stage ? " on" : ""}`} onClick={() => setStage(i)}>
            <div class="step">Stage {i + 1}</div>
            <div class="name">{x.label}</div>
            <div class="val">hit@10 {pct(x["hit@10"])}</div>
            <div class="bar"><i style={{ width: `${100 * x["hit@10"]}%` }} /></div>
          </button>
        ))}
      </div>
      <div class="stage-detail" aria-live="polite">
        <h3>{s.label}</h3>
        <p dangerouslySetInnerHTML={{ __html: inlineCode(s.blurb) }} />
        <div class="funnel">scores <b>{pool}</b> · {what}</div>
        <div class="funnel">
          function: hit@1 <b>{pct(s["hit@1"])}</b> · hit@10 <b>{pct(s["hit@10"])}</b> · MRR <b>{fixed3(s.mrr)}</b>
          {file && <> &nbsp;|&nbsp; file: hit@5 <b>{pct(file["hit@5"])}</b> · hit@10 <b>{pct(file["hit@10"])}</b></>}
          {lat != null && <> &nbsp;|&nbsp; query p50 <b>{lat.toFixed(lat < 10 ? 2 : 0)} ms</b></>}
        </div>
      </div>
    </>
  );
}
