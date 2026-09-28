import { useState } from "preact/hooks";

export interface Bar {
  label: string;
  value: number;
  /** 95% interval, drawn as a thin whisker. */
  ci?: [number, number];
  /** Extra line for the tooltip (sample size, latency...). */
  detail?: string;
  /** The row the reader should compare against, drawn in the full accent. */
  emphasis?: boolean;
}

/**
 * Horizontal bars for one measure across ordered steps: one hue, value labelled at the end,
 * a hover/focus tooltip, and the numbers in text for screen readers. Values are 0..1.
 */
export function Bars({ rows, format, label }: { rows: Bar[]; format: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div class="bars" role="group" aria-label={label}>
      {rows.map((r, i) => (
        <div class={`bar-row${r.emphasis ? " emph" : ""}${hover === i ? " hot" : ""}`} key={r.label} tabIndex={0} role="img"
          onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
          aria-label={`${r.label}: ${format(r.value)}${r.ci ? `, 95% interval ${format(r.ci[0])} to ${format(r.ci[1])}` : ""}`}>
          <span class="bar-label">{r.label}</span>
          <span class="bar-track">
            <i class="bar-fill" style={{ width: `${100 * r.value}%` }} />
            {r.ci && <i class="bar-ci" style={{ left: `${100 * r.ci[0]}%`, width: `${100 * (r.ci[1] - r.ci[0])}%` }} />}
            {hover === i && (
              <span class="bar-tip" role="tooltip" style={{ left: `${Math.min(88, Math.max(12, 100 * r.value))}%` }}>
                <b>{format(r.value)}</b>
                {r.ci && <span>95% interval {format(r.ci[0])}–{format(r.ci[1])}</span>}
                {r.detail && <span>{r.detail}</span>}
              </span>
            )}
          </span>
          <span class="bar-value">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
