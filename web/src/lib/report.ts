export type Block = { kind: "prose" | "code"; text: string };

const FENCE = /^\s*(```|~~~)/;
const CODE_LINE = [
  /^(\t| {2,})\S/,
  /^\s*(>>>|\.\.\.)(\s|$)/,
  /^\s*Traceback \(most recent call last\)/,
  /^\s*File "[^"]+", line \d+/,
  /^\s*(def|class|import|from|return|raise|async def|@[\w.]+)\b.*[:)\w\]]$/,
  /^[A-Za-z_][\w.]*(Error|Exception|Warning|Exit|Interrupt)(: .*)?$/,
  /^\s*[\w.\]\[]+\s*=\s*\S.*[)\]}'"\w]$/,
];

const looksLikeCode = (line: string): boolean => CODE_LINE.some((re) => re.test(line));

const depthChange = (line: string): number => {
  const bare = line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "").replace(/#.*$/, "");
  return (bare.match(/[([{]/g)?.length ?? 0) - (bare.match(/[)\]}]/g)?.length ?? 0);
};

export function reportBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const push = (kind: Block["kind"], chunk: string[]) => {
    const body = kind === "code" ? chunk.join("\n").replace(/\t/g, "    ").replace(/^\n+|\s+$/g, "") : chunk.join("\n").trim();
    if (!body) return;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.text += `\n${kind === "code" ? "" : "\n"}${body}`;
    else blocks.push({ kind, text: body });
  };
  let prose: string[] = [];
  let code: string[] = [];
  let fenced = false;
  let depth = 0;
  const flushProse = () => {
    push("prose", prose);
    prose = [];
  };
  const flushCode = () => {
    push("code", code);
    code = [];
    depth = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      if (fenced) flushCode();
      else flushProse();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      code.push(line);
      continue;
    }
    const blankInsideCode = line.trim() === "" && code.length > 0 && i + 1 < lines.length && looksLikeCode(lines[i + 1]);
    if (looksLikeCode(line) || blankInsideCode || (code.length > 0 && depth > 0)) {
      if (!code.length) flushProse();
      code.push(line);
      depth = Math.max(0, depth + depthChange(line));
    } else {
      if (code.length) flushCode();
      prose.push(line);
    }
  }
  if (fenced || code.length) flushCode();
  flushProse();
  return blocks;
}

export function inlineSpans(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`\n]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}
