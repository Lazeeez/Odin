/** Ornaments: gold line-work drawn as SVG, so it stays crisp at any size and follows the theme. */

/**
 * Elder Futhark runes as strokes in an 8 x 16 box. Drawn rather than typed: few fonts carry the
 * runic block. Othala, sowilo, algiz and tiwaz are left out on purpose; hate groups have claimed them.
 */
export const RUNES = [
  "M2 0V16M2 5 8 1M2 9 8 5", // fehu
  "M1 16V0L7 5V16", // uruz
  "M2 0V16M2 4 7 8 2 12", // thurisaz
  "M2 0V16M2 1 8 5M2 6 8 10", // ansuz, Odin's own rune
  "M2 16V0L7 4 2 8 8 16", // raido
  "M7 3 2 8 7 13", // kaunan
  "M1 2 7 14M7 2 1 14", // gebo
  "M2 16V0L7 4 2 8", // wunjo
  "M1 0V16M7 0V16M1 5 7 11", // hagalaz
  "M4 0V16M1 5 7 11", // naudiz
  "M4 0V16", // isa
  "M4 1 1 5 4 9M4 7 7 11 4 15", // jera
  "M4 0V16M4 0 7 3M4 16 1 13", // eihwaz
  "M1 16V0L4 5 7 0V16", // ehwaz
  "M1 16V0L7 8M7 16V0L1 8", // mannaz
  "M2 16V0L7 5", // laguz
  "M4 3 7.5 8 4 13 0.5 8Z", // ingwaz
  "M1 2V14L7 2V14L1 2", // dagaz
  "M2 0V16M2 0 7 4 2 8 7 12 2 16", // berkano
];

const RING = [...RUNES, ...RUNES];

/** A ring of runes that draws itself in, then turns very slowly (still, for reduced motion). */
export function RuneRing() {
  const step = 360 / RING.length;
  return (
    <div class="rune-ring" aria-hidden="true">
      <svg class="ring-outer" viewBox="-200 -200 400 400">
        <defs>
          <linearGradient id="ring-gilt" gradientUnits="userSpaceOnUse" x1="-200" y1="-200" x2="200" y2="200">
            <stop offset="0" stop-color="#b07c1c" />
            <stop offset=".3" stop-color="#e8c05a" />
            <stop offset=".45" stop-color="#fff0b3" />
            <stop offset=".6" stop-color="#d9a63a" />
            <stop offset="1" stop-color="#a8751a" />
          </linearGradient>
        </defs>
        <circle r="197" pathLength={1} class="draw" />
        <circle r="192" pathLength={1} class="draw faint" />
        {RING.map((d, i) => (
          <g key={i} class="rune" style={{ "--i": i }} transform={`rotate(${i * step}) translate(0 -172) scale(1.3) translate(-4 -8)`}>
            <path d={d} />
          </g>
        ))}
        {RING.map((_, i) => (
          <g key={`s${i}`} transform={`rotate(${(i + 0.5) * step})`} class="sep">
            <circle cy="-175" r="1.1" />
            <circle cy="-169" r="1.1" />
          </g>
        ))}
        <circle r="152" pathLength={1} class="draw" />
        <circle r="147" pathLength={1} class="draw faint" />
      </svg>
      <svg class="ring-inner" viewBox="-200 -200 400 400">
        {Array.from({ length: 72 }, (_, i) => (
          <line key={i} transform={`rotate(${i * 5})`} y1={-140} y2={i % 6 ? -135 : -128} />
        ))}
        <circle r="124" pathLength={1} class="draw faint" />
      </svg>
    </div>
  );
}

/** Light behind the ring: slow god-rays, a few rising embers and, at night, stars. */
export function HeroSky() {
  // fixed pseudo-random embers, so the layout is the same on every visit
  const embers = Array.from({ length: 18 }, (_, i) => {
    const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    return { x: 6 + r(1) * 88, d: 9 + r(2) * 10, delay: -r(3) * 18, s: 2 + r(4) * 3, drift: (r(5) - 0.5) * 60 };
  });
  return (
    <div class="hero-sky" aria-hidden="true">
      <div class="stars" />
      <div class="rays" />
      {embers.map((e, i) => (
        <i key={i} class="ember" style={{ left: `${e.x}%`, width: `${e.s}px`, height: `${e.s}px`, "--dur": `${e.d}s`, "--delay": `${e.delay}s`, "--drift": `${e.drift}px` }} />
      ))}
    </div>
  );
}

/** A double gold rule with a lozenge in the middle, between sections. */
export const Divider = () => (
  <div class="divider" aria-hidden="true">
    <i />
    <svg viewBox="0 0 28 14">
      <path d="M14 1 20 7 14 13 8 7Z" />
      <path d="M1 7h4M23 7h4" />
    </svg>
    <i />
  </div>
);

/** Line icons for the features, each with a nod to the myth. */
export const ICONS = {
  // Huginn and Muninn, Odin's ravens, who fly out over the world and bring back what they find
  raven:
    "M2.5 10.5c2.6-.6 5 .1 6.9 2 .5-2.6 2.5-4.6 5.1-5.2L17 6.5l2.3-2.1.4 2.5 2.3.6-2.3 1.2c-.2 3.6-2.5 6.6-5.9 7.5L12 19.5l-.4-3.3c-3.9-.4-7.1-2.6-9.1-5.7Z",
  // the one eye he gave for wisdom
  eye: "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  // a round shield with its boss and planks
  shield: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM12 3v6.5M12 14.5V21M3 12h6.5M14.5 12H21",
  // ansuz, the rune of Odin and of speech
  ansuz: "M8 3v18M8 4l8 5M8 10l8 5",
  // Yggdrasil
  tree: "M12 21V8M12 13l-4-3.5M12 11l4-4M12 16l3.5-2.5M5 10a7 7 0 0 1 14 0M9 21h6",
} as const;

export const Icon = ({ name }: { name: keyof typeof ICONS }) => (
  <svg class="myth-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name]} pathLength={1} /></svg>
);
