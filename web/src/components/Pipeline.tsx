import { useState } from "preact/hooks";
import { type Summary, stagesAt } from "../lib/data.ts";
import { fixed3, inlineCode, pct } from "../lib/format.ts";
import { plainName, plainWhat } from "../lib/stages.ts";

const FUNNEL: [string, string][] = [
  ["every function", "keyword scores, words as written"],
  ["every function", "identifier-aware keyword scores, tests excluded"],
  ["every function", "keyword and code-embedding scores, fused"],
  ["~450 candidates", "LambdaMART over 52 signals"],
  ["top 20", "fine-tuned LLM cross-encoder, blended in"],
];

/** The ranking cascade as clickable steps: each is costlier per candidate and sees fewer. */
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
            <span class="step">{i + 1}</span>
            <span class="name">{plainName(x.id, x.label)}</span>
            <span class="val">{pct(x["hit@10"])}</span>
          </button>
        ))}
      </div>
      <div class="stage-detail" role="tabpanel" aria-live="polite">
        <h3>{plainName(s.id, s.label)} <span class="muted small">· {plainWhat(s.id)}</span></h3>
        <p dangerouslySetInnerHTML={{ __html: inlineCode(s.blurb) }} />
        <dl class="facts">
          <div><dt>Scores</dt><dd>{pool}</dd></div>
          <div><dt>How</dt><dd>{what}</dd></div>
          <div><dt>Function in top 10</dt><dd>{pct(s["hit@10"])}</dd></div>
          <div><dt>Ranked first</dt><dd>{pct(s["hit@1"])}</dd></div>
          <div><dt title="Mean reciprocal rank: 1 if the fix is always first, 0.5 if always second">MRR</dt><dd>{fixed3(s.mrr)}</dd></div>
          {file && <div><dt>File in top 5</dt><dd>{pct(file["hit@5"])}</dd></div>}
          {lat != null && <div><dt>Per query (p50)</dt><dd>{lat < 10 ? lat.toFixed(1) : Math.round(lat).toLocaleString()} ms</dd></div>}
        </dl>
      </div>
    </>
  );
}
