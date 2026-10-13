import { Emblem } from "./Emblem.tsx";
import { RUNES } from "./Myth.tsx";

const N = 24;
const RING = Array.from({ length: N }, (_, i) => RUNES[i % RUNES.length]);

/**
 * Progress as a circle of runes: each lights up in gold as the load passes it, and the living eye
 * watches from the centre. No numbers on screen; the exact value is on the progressbar role for
 * screen readers. The small inline version, too small for runes, draws a thin gold arc instead.
 */
export function RuneProgress({ fraction, label, size = "lg" }: { fraction?: number | null; label?: string; size?: "sm" | "lg" }) {
  const f = fraction == null ? null : Math.max(0, Math.min(1, fraction));
  const lit = f == null ? 0 : Math.floor(f * N + 1e-9);
  return (
    <div class={`rune-progress rp-${size}${f == null ? " busy" : ""}`} role="progressbar" aria-label={label ?? "Loading"}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={f == null ? undefined : Math.round(100 * f)}>
      <svg viewBox="-100 -100 200 200" aria-hidden="true">
        {size === "sm" && (
          <>
            <circle class="rp-track" r="92" />
            <circle class="rp-arc" r="92" pathLength={1} style={{ strokeDashoffset: f == null ? undefined : 1 - f }} transform="rotate(-90)" />
          </>
        )}
        {size === "lg" && RING.map((d, i) => (
          <g key={i} class={i < lit ? "on" : ""} style={{ "--i": i }} transform={`rotate(${(i * 360) / N}) translate(0 -76) scale(1.25) translate(-4 -8)`}>
            <path d={d} />
          </g>
        ))}
      </svg>
      <span class="rp-eye"><Emblem live /></span>
    </div>
  );
}
