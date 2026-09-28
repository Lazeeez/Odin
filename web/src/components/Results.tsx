import { useState } from "preact/hooks";
import { type Metric, type Stage, type Summary, stagesAt } from "../lib/data.ts";
import { metricLabel } from "../lib/format.ts";
import { Bars } from "./Bars.tsx";
import { Seg } from "./Seg.tsx";

const METRICS: readonly (readonly [Metric, string])[] = [
  ["hit@1", "Top 1"], ["hit@5", "Top 5"], ["hit@10", "Top 10"], ["recall@10", "Recall@10"], ["mrr", "MRR"],
];
const NOTES: Record<Metric, string> = {
  "hit@1": "Share of bugs where the first result is a place the real fix changed.",
  "hit@5": "Share of bugs with at least one real fix location in the first 5 results.",
  "hit@10": "Share of bugs with at least one real fix location in the first 10 results.",
  "recall@10": "Share of all fix locations found in the top 10 (one fix can touch several functions).",
  mrr: "Mean reciprocal rank: 1 / rank of the first correct result, averaged. 1.0 would mean always first.",
};

/** Each pipeline stage on one measure, with its 95% bootstrap interval. */
export function StageChart({ summary }: { summary: Summary }) {
  const [level, setLevel] = useState<Stage["level"]>("function");
  const [metric, setMetric] = useState<Metric>("hit@10");
  const rows = stagesAt(summary, level);
  return (
    <>
      <div class="controls">
        <Seg small label="Level" value={level} onChange={setLevel} options={[["function", "Functions"], ["file", "Files"]] as const} />
        <Seg small label="Metric" value={metric} onChange={setMetric} options={METRICS} />
      </div>
      <Bars
        label={`${metric} by pipeline stage, ${level} level`}
        format={(v) => metricLabel(metric, v)}
        rows={rows.map((r, i) => ({
          label: r.label, value: r[metric], ci: r.ci95?.[metric], emphasis: i === rows.length - 1,
          detail: `${r.n} issues${r.latency_ms_p50 != null ? ` · ${r.latency_ms_p50 < 10 ? r.latency_ms_p50.toFixed(1) : Math.round(r.latency_ms_p50)} ms per query (p50)` : ""}`,
        }))}
      />
      <p class="note">{NOTES[metric]}</p>
    </>
  );
}

export function SignificanceTable({ summary }: { summary: Summary }) {
  const [level, setLevel] = useState<Stage["level"]>("function");
  const rows = stagesAt(summary, level);
  return (
    <>
      <div class="controls"><Seg small label="Level" value={level} onChange={setLevel} options={[["function", "Functions"], ["file", "Files"]] as const} /></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Step</th><th>Metric</th><th>Change</th><th>95% interval</th><th>p</th><th>Wins / losses</th></tr></thead>
          <tbody>
            {rows.slice(1).flatMap((to, i) => {
              const from = rows[i];
              const res = summary.significance[`${level}:${from.id}->${to.id}`];
              if (!res) return [];
              return (["recall@10", "mrr"] as const).map((m, j) => {
                const r = res[m];
                const sig = r.p < 0.05 && r.delta > 0;
                return (
                  <tr key={`${to.id}-${m}`}>
                    {j === 0 && <td rowSpan={2}><span class="muted">{from.label} →</span><br /><b>{to.label}</b></td>}
                    <td>{m === "mrr" ? "MRR" : "Recall@10"}</td>
                    <td class={`num${sig ? " sig" : ""}`}>{r.delta >= 0 ? "+" : ""}{r.delta.toFixed(3)}</td>
                    <td class="num">[{r.ci95[0].toFixed(3)}, {r.ci95[1].toFixed(3)}]</td>
                    <td class="num">{r.p < 0.001 ? "<0.001" : r.p.toFixed(3)}{sig ? <span class="sig-mark" title="significant at p < 0.05"> ✓</span> : null}</td>
                    <td class="num">{r.wins} / {r.losses}</td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
      <p class="note">Paired bootstrap over the same issues (10,000 resamples). ✓ marks an improvement significant at p &lt; 0.05.</p>
    </>
  );
}

export function RepoTable({ summary }: { summary: Summary }) {
  const rows = stagesAt(summary, "function");
  const last = rows.at(-1)!;
  const repos = Object.keys(last.by_repo).sort((a, b) => last.by_repo[b].n - last.by_repo[a].n);
  return (
    <div class="table-wrap">
      <table class="heat">
        <thead><tr><th>Repository</th><th>Issues</th>{rows.map((r) => <th key={r.id}>{r.label}</th>)}</tr></thead>
        <tbody>
          {repos.map((repo) => (
            <tr key={repo}>
              <td>{repo}</td>
              <td class="num">{last.by_repo[repo].n}</td>
              {rows.map((r) => {
                const v = r.by_repo[repo]?.["recall@10"];
                return v == null ? <td key={r.id} /> : (
                  <td key={r.id} class="num" style={{ background: `color-mix(in srgb, var(--mark) ${Math.round(v * 40)}%, transparent)` }}>{v.toFixed(2)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
