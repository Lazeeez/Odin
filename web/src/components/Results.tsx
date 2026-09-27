import { useState } from "preact/hooks";
import { type Metric, type Stage, type Summary, stagesAt } from "../lib/data.ts";
import { fixed3, metricLabel } from "../lib/format.ts";
import { Seg } from "./Seg.tsx";

const METRICS: readonly (readonly [Metric, string])[] = [
  ["hit@1", "hit@1"], ["hit@5", "hit@5"], ["hit@10", "hit@10"], ["recall@10", "recall@10"], ["mrr", "MRR"],
];
const NOTES: Record<Metric, string> = {
  "hit@1": "hit@1: the first result is a place the real fix changed.",
  "hit@5": "hit@5: at least one real fix location is in the first 5 results.",
  "hit@10": "hit@10: at least one real fix location is in the first 10 results.",
  "recall@10": "recall@10: share of all fix locations found in the top 10 (fixes can touch several functions).",
  mrr: "MRR: 1 / rank of the first correct result, averaged. 1.0 would mean always first.",
};

/** A bar chart in plain SVG: five bars do not need a charting library. */
function LadderChart({ rows, metric }: { rows: Stage[]; metric: Metric }) {
  const W = 900, H = 320, padL = 40, padB = 64, padT = 24;
  const bw = (W - padL - 20) / rows.length;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v);
  const summary = rows.map((r) => `${r.label} ${metricLabel(metric, r[metric])}`).join(", ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric} by stage: ${summary}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line class="axis" x1={padL} x2={W - 10} y1={y(t)} y2={y(t)} />
          <text x={padL - 8} y={y(t) + 4} text-anchor="end">{Math.round(t * 100)}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const v = r[metric];
        const x = padL + i * bw + bw * 0.18, w = bw * 0.64, cx = x + w / 2;
        const ci = r.ci95?.[metric];
        const words = r.label.split(" ");
        const mid = Math.ceil(words.length / 2);
        return (
          <g key={r.id}>
            <rect x={x} y={y(v)} width={w} height={y(0) - y(v)} rx={6} fill={`var(--stage-${i + 1})`} class="bar-rect">
              <title>{`${r.label}: ${fixed3(v)}`}</title>
            </rect>
            {ci && (
              <>
                <line class="ci" x1={cx} x2={cx} y1={y(ci[1])} y2={y(ci[0])} />
                {ci.map((b) => <line key={b} class="ci" x1={cx - 6} x2={cx + 6} y1={y(b)} y2={y(b)} />)}
              </>
            )}
            <text class="val-label" x={cx} y={y(ci ? ci[1] : v) - 8} text-anchor="middle">{metricLabel(metric, v)}</text>
            <text x={cx} y={H - padB + 20} text-anchor="middle">{words.slice(0, mid).join(" ")}</text>
            <text x={cx} y={H - padB + 36} text-anchor="middle">{words.slice(mid).join(" ")}</text>
          </g>
        );
      })}
    </svg>
  );
}

function SignificanceTable({ summary, level }: { summary: Summary; level: Stage["level"] }) {
  const rows = stagesAt(summary, level);
  return (
    <div class="table-wrap">
      <table>
        <thead><tr><th>Step</th><th>Metric</th><th>Δ</th><th>95% CI</th><th>p</th><th>wins / losses</th></tr></thead>
        <tbody>
          {rows.slice(1).flatMap((to, i) => {
            const from = rows[i];
            const res = summary.significance[`${level}:${from.id}->${to.id}`];
            if (!res) return [];
            return (["recall@10", "mrr"] as const).map((m, j) => {
              const r = res[m];
              const cls = r.p < 0.05 && r.delta > 0 ? "sig-yes" : "sig-no";
              return (
                <tr key={`${to.id}-${m}`}>
                  {j === 0 && <td rowSpan={2}>{from.label} → <b>{to.label}</b></td>}
                  <td>{m}</td>
                  <td class={`num ${cls}`}>{r.delta >= 0 ? "+" : ""}{r.delta.toFixed(3)}</td>
                  <td class="num">[{r.ci95[0].toFixed(3)}, {r.ci95[1].toFixed(3)}]</td>
                  <td class={`num ${cls}`}>{r.p < 0.001 ? "<0.001" : r.p.toFixed(3)}</td>
                  <td class="num">{r.wins} / {r.losses}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

function RepoTable({ summary }: { summary: Summary }) {
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
                  <td key={r.id} class="num" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(v * 45)}%, transparent)` }}>{v.toFixed(2)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Results({ summary }: { summary: Summary }) {
  const [level, setLevel] = useState<Stage["level"]>("function");
  const [metric, setMetric] = useState<Metric>("hit@10");
  return (
    <>
      <div class="controls">
        <Seg label="Level" value={level} onChange={setLevel} options={[["function", "Function level"], ["file", "File level"]] as const} />
        <Seg label="Metric" value={metric} onChange={setMetric} options={METRICS} />
      </div>
      <div class="chart"><LadderChart rows={stagesAt(summary, level)} metric={metric} /></div>
      <p class="note">{NOTES[metric]}</p>
      <h3>Is each step real? Paired bootstrap tests</h3>
      <SignificanceTable summary={summary} level={level} />
      <h3>By repository <span class="muted">(recall@10, function level)</span></h3>
      <RepoTable summary={summary} />
    </>
  );
}
