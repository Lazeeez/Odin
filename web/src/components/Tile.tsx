import { useRef } from "preact/hooks";
import { pct } from "../lib/format.ts";
import { useCountUp } from "../lib/reveal.ts";

/** A headline number in a gold frame; it counts up when it scrolls into view. */
export function Tile({ label, value, note }: { label: string; value: number | null; note: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useCountUp(value, el);
  return (
    <div class="tile frame">
      <span class="tile-label">{label}</span>
      <span class="tile-value" ref={el} aria-hidden="true">{shown != null ? pct(shown) : "–"}</span>
      {value != null && <span class="sr-only">{pct(value)}</span>}
      <span class="tile-note">{note}</span>
    </div>
  );
}
