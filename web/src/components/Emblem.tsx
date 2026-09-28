import { useId } from "preact/hooks";

/** 24 dial marks inside the rim, diamonds at the quarters. */
const TICKS = Array.from({ length: 24 }, (_, i) => i);
/**
 * The pupil is a triquetra woven through a ring. Three arcs make the knot; where strands cross, the
 * one on top is redrawn inside a small clip with a gap-coloured halo, so the weave alternates over
 * and under all the way round (computed once, offline, from the arcs' intersections).
 */
const KNOT = [
  "M32 22.8A8.28 8.28 0 0 0 39.97 36.6",
  "M39.97 36.6A8.28 8.28 0 0 0 24.03 36.6",
  "M24.03 36.6A8.28 8.28 0 0 0 32 22.8",
];
const KNOT_RING = 5.15;
/** Crossings where a knot arc passes over: [x, y, arc]. Everywhere else the ring or the later arc is on top. */
const OVER: [number, number, number][] = [
  [32, 34.35, 0], [29.97, 30.82, 1], [34.03, 30.82, 2], [29.75, 27.37, 0], [37.14, 32.36, 1], [29.12, 36.27, 2],
];

function Strand({ d, ring, halo }: { d?: string; ring?: boolean; halo: string }) {
  const shape = ring ? { cx: 32, cy: 32, r: KNOT_RING } : { d };
  const Tag = ring ? "circle" : "path";
  return (
    <>
      <Tag {...shape} fill="none" stroke={halo} stroke-width="2.25" />
      <Tag {...shape} fill="none" stroke="#0a0e1c" stroke-width="1.45" stroke-linecap="round" />
    </>
  );
}

/**
 * Odin's eye: a gold-rimmed medallion with a rune dial and one open eye. The same drawing is the
 * logo (still) and the loading symbol (`live`: the dial turns, the knot spins, the eye blinks).
 */
export function Emblem({ live = false, class: cls = "" }: { live?: boolean; class?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const u = (name: string) => `url(#${name}${id})`;
  return (
    <svg class={`emblem${live ? " live" : ""} ${cls}`} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id={`disc${id}`} cx="50%" cy="38%" r="70%">
          <stop offset="0" stop-color="#26335e" />
          <stop offset="1" stop-color="#0a0e1c" />
        </radialGradient>
        <linearGradient id={`gold${id}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stop-color="#f7e2a0" />
          <stop offset=".55" stop-color="#d4aa52" />
          <stop offset="1" stop-color="#9c7026" />
        </linearGradient>
        <radialGradient id={`iris${id}`} gradientUnits="userSpaceOnUse" cx="30.24" cy="29.36" r="13.64">
          <stop offset="0" stop-color="#fff3c8" />
          <stop offset=".4" stop-color="#e9c46c" />
          <stop offset="1" stop-color="#8e6320" />
        </radialGradient>
        {OVER.map(([x, y], i) => <clipPath key={i} id={`x${i}${id}`}><circle cx={x} cy={y} r="1.7" /></clipPath>)}
        <clipPath id={`eye${id}`}>
          <path d="M8.5 32C16.5 21 24 16.5 32 16.5S47.5 21 55.5 32C47.5 43 40 47.5 32 47.5S16.5 43 8.5 32Z" />
        </clipPath>
      </defs>

      <circle cx="32" cy="32" r="30.6" fill={u("disc")} stroke={u("gold")} stroke-width="2.2" />
      <circle cx="32" cy="32" r="26.2" fill="none" stroke="#c9a04a" stroke-width=".6" opacity=".55" />
      <g class="em-dial" fill="#e0bb66" stroke="#d4aa52" stroke-linecap="round">
        {TICKS.map((i) =>
          i % 6 ? (
            <line key={i} x1="32" y1="3.9" x2="32" y2="5.6" stroke-width=".9" opacity=".75" transform={`rotate(${i * 15} 32 32)`} />
          ) : (
            <path key={i} d="M32 2.9 33.3 4.7 32 6.5 30.7 4.7Z" stroke="none" transform={`rotate(${i * 15} 32 32)`} />
          ),
        )}
      </g>
      <g class="em-eye">
        <path d="M8.5 32C16.5 21 24 16.5 32 16.5S47.5 21 55.5 32C47.5 43 40 47.5 32 47.5S16.5 43 8.5 32Z" fill="#070a14" />
        <g clip-path={u("eye")}>
          <g class="em-iris">
            <circle cx="32" cy="32" r="11" fill={u("iris")} />
            <circle cx="32" cy="32" r="11" fill="none" stroke="#6b4711" stroke-width="1.1" opacity=".7" />
          </g>
          <g class="em-knot">
            {KNOT.map((d) => <Strand key={d} d={d} halo={u("iris")} />)}
            <Strand ring halo={u("iris")} />
            {OVER.map(([, , arc], i) => <g key={i} clip-path={u(`x${i}`)}><Strand d={KNOT[arc]} halo={u("iris")} /></g>)}
          </g>
          <circle cx="39.4" cy="26" r="1.3" fill="#fff8e2" opacity=".9" />
        </g>
        <path d="M8.5 32C16.5 21 24 16.5 32 16.5S47.5 21 55.5 32C47.5 43 40 47.5 32 47.5S16.5 43 8.5 32Z" fill="none"
          stroke={u("gold")} stroke-width="2.4" stroke-linejoin="round" />
      </g>
    </svg>
  );
}

/**
 * The loading symbol, with an optional line of text beside or under it. It is decoration: the
 * pages it sits on already announce progress in their own live regions.
 */
export function Seer({ text, size = "md" }: { text?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span class={`seer seer-${size}`}>
      <span class="seer-halo" aria-hidden="true" />
      <Emblem live />
      {text && <span class="seer-text">{text}</span>}
    </span>
  );
}
