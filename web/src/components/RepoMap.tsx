import { useEffect, useMemo, useRef, useState } from "preact/hooks";

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  units: number;
  weight: number;
  depth: number;
  a0: number;
  a1: number;
}
interface Leaf { x: number; y: number; node: Node }

/** Folders and files as a tree; a file's weight grows with the square root of its unit count. */
function build(files: [string, number][]): { root: Node; depth: number } {
  const root: Node = { name: "", path: "", children: new Map(), units: 0, weight: 0, depth: 0, a0: 0, a1: 0 };
  let depth = 1;
  for (const [path, units] of files) {
    let node = root;
    const parts = path.split("/");
    parts.forEach((name, i) => {
      let child = node.children.get(name);
      if (!child) {
        child = { name, path: parts.slice(0, i + 1).join("/"), children: new Map(), units: 0, weight: 0, depth: i + 1, a0: 0, a1: 0 };
        node.children.set(name, child);
      }
      child.units += units;
      node = child;
    });
    node.weight = Math.sqrt(units);
    depth = Math.max(depth, parts.length);
  }
  const sum = (n: Node): number => (n.children.size ? (n.weight = [...n.children.values()].reduce((s, c) => s + sum(c), 0)) : n.weight);
  sum(root);
  const place = (n: Node, a0: number, a1: number) => {
    n.a0 = a0;
    n.a1 = a1;
    let a = a0;
    for (const c of [...n.children.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      const span = ((a1 - a0) * c.weight) / (n.weight || 1);
      place(c, a, a + span);
      a += span;
    }
  };
  place(root, -Math.PI / 2, (3 * Math.PI) / 2);
  return { root, depth };
}

/**
 * Yggdrasil: the repository as a radial tree, folders branching out from the trunk at the centre
 * and every file a leaf. The files of the top results glow gold, with their branches lit back to
 * the root. Canvas, drawn once per result set.
 */
export default function RepoMap({ files, hits, onPick }: { files: [string, number][]; hits: string[]; onPick?: (path: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const leaves = useRef<Leaf[]>([]);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Redrawn when the canvas changes size or the theme flips (its colours come from the theme).
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const bump = () => setFrame((n) => n + 1);
    const ro = new ResizeObserver(bump);
    if (canvas.current) ro.observe(canvas.current);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);
  const tree = useMemo(() => build(files), [files]);
  const rankOf = useMemo(() => {
    const m = new Map<string, number>();
    hits.forEach((p, i) => { if (!m.has(p)) m.set(p, i + 1); });
    return m;
  }, [hits]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const line = css.getPropertyValue("--line-2").trim() || "#d9c69c";
    const gold = css.getPropertyValue("--gold-bright").trim() || "#d9a63a";
    const ink = css.getPropertyValue("--ink").trim() || "#1c1b22";
    const muted = css.getPropertyValue("--muted").trim() || "#6b6250";
    const W = el.clientWidth;
    const H = el.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    el.width = W * dpr;
    el.height = H * dpr;
    const g = el.getContext("2d")!;
    g.scale(dpr, dpr);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 34;
    const step = R / tree.depth;
    const pos = (n: Node, r = n.depth * step) => {
      const a = (n.a0 + n.a1) / 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
    };
    const lit = new Set<string>();
    for (const p of rankOf.keys()) p.split("/").forEach((_, i, parts) => lit.add(parts.slice(0, i + 1).join("/")));

    const found: Leaf[] = [];
    const branch = (n: Node) => {
      const [x0, y0] = n.depth ? pos(n) : [cx, cy];
      for (const c of n.children.values()) {
        const [x1, y1] = pos(c);
        const [mx, my] = pos(c, (c.depth - 0.5) * step);
        const on = lit.has(c.path);
        g.strokeStyle = on ? gold : line;
        g.lineWidth = on ? 2 : Math.max(0.5, Math.min(2.4, Math.sqrt(c.weight) / 3));
        g.globalAlpha = on ? 1 : 0.75;
        g.beginPath();
        g.moveTo(x0, y0);
        g.quadraticCurveTo(mx, my, x1, y1);
        g.stroke();
        if (c.children.size) branch(c);
        else found.push({ x: x1, y: y1, node: c });
      }
    };
    g.clearRect(0, 0, W, H);
    g.lineCap = "round";
    branch(tree.root);
    g.globalAlpha = 1;
    for (const l of found) {
      if (rankOf.has(l.node.path)) continue;
      g.fillStyle = muted;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.arc(l.x, l.y, Math.min(3.2, 1 + Math.sqrt(l.node.units) / 4), 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    // the results last, on top: glowing leaves with their rank
    for (const l of found) {
      const rank = rankOf.get(l.node.path);
      if (!rank) continue;
      g.shadowColor = gold;
      g.shadowBlur = 14;
      g.fillStyle = gold;
      g.beginPath();
      g.arc(l.x, l.y, rank === 1 ? 7 : 5, 0, 7);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = ink;
      g.font = "600 11px 'JetBrains Mono Variable', monospace";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(rank), l.x, l.y - (rank === 1 ? 16 : 13));
    }
    // the trunk
    g.fillStyle = gold;
    g.beginPath();
    g.arc(cx, cy, 5, 0, 7);
    g.fill();
    leaves.current = found;
  }, [tree, rankOf, frame]);

  const nearest = (e: MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: Leaf | null = null;
    let bd = 12 * 12;
    for (const l of leaves.current) {
      const d = (l.x - x) ** 2 + (l.y - y) ** 2;
      if (d < bd) [best, bd] = [l, d];
    }
    return { best, x, y };
  };

  return (
    <div class="repo-map">
      <canvas ref={canvas} role="img"
        aria-label={`Map of ${files.length.toLocaleString()} files; the top results are in ${[...rankOf.keys()].slice(0, 5).join(", ")}`}
        onPointerMove={(e) => {
          const { best, x, y } = nearest(e);
          const rank = best ? rankOf.get(best.node.path) : undefined;
          setTip(best ? { x, y, text: `${rank ? `#${rank} · ` : ""}${best.node.path} · ${best.node.units} functions and classes` } : null);
        }}
        onPointerLeave={() => setTip(null)}
        onClick={(e) => {
          const { best } = nearest(e);
          if (best && rankOf.has(best.node.path)) onPick?.(best.node.path);
        }} />
      {tip && <span class="map-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{tip.text}</span>}
      <p class="note">
        Folders branch out from the centre; each leaf is a file, sized by its functions. Gold leaves hold the top results (the number is
        the rank of the file's best function), and their branches light up back to the root.
      </p>
    </div>
  );
}
