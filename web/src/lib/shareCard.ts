export interface CardHit {
  qualname: string;
  path: string;
  line: number;
}

export interface CardInput {
  repo: string;
  query: string;
  hits: CardHit[];
  stage: string;
  site: string;
}

const W = 1200;
const H = 630;
const COLORS = { bg: "#0d1426", panel: "#152040", gold: "#d9a93a", ink: "#f3ead7", muted: "#a9b0c3", line: "#2a3658" };

const fit = (ctx: CanvasRenderingContext2D, text: string, width: number): string => {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
};

export const cardTitle = (query: string): string => {
  const first = query.replace(/\r/g, "").split("\n").find((l) => l.trim()) ?? "";
  return first.trim().replace(/\s+/g, " ");
};

export async function drawCard(input: CardInput): Promise<Blob> {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const css = getComputedStyle(document.documentElement);
  const display = css.getPropertyValue("--display").trim() || "serif";
  const sans = css.getPropertyValue("--sans").trim() || "sans-serif";
  const mono = css.getPropertyValue("--mono").trim() || "monospace";

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.fillStyle = COLORS.gold;
  ctx.font = `600 34px ${display}`;
  ctx.fillText("ODIN", 64, 92);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 22px ${sans}`;
  ctx.fillText(fit(ctx, `Where to fix it in ${input.repo}`, W - 260), 170, 90);

  ctx.fillStyle = COLORS.ink;
  ctx.font = `600 34px ${sans}`;
  ctx.fillText(fit(ctx, cardTitle(input.query), W - 128), 64, 160);

  input.hits.slice(0, 3).forEach((h, i) => {
    const y = 214 + i * 104;
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(64, y, W - 128, 88);
    ctx.fillStyle = COLORS.gold;
    ctx.font = `600 40px ${display}`;
    ctx.fillText(String(i + 1), 88, y + 58);
    ctx.fillStyle = COLORS.ink;
    ctx.font = `600 30px ${mono}`;
    ctx.fillText(fit(ctx, h.qualname, W - 260), 144, y + 40);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `400 22px ${mono}`;
    ctx.fillText(fit(ctx, `${h.path}:${h.line}`, W - 260), 144, y + 72);
  });

  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 20px ${sans}`;
  ctx.fillText(fit(ctx, input.stage, W - 420), 64, H - 56);
  ctx.fillStyle = COLORS.gold;
  ctx.font = `600 22px ${sans}`;
  ctx.textAlign = "right";
  ctx.fillText(input.site, W - 64, H - 56);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not draw the card"))), "image/png"));
}

export async function shareCard(input: CardInput, link: string): Promise<"shared" | "downloaded"> {
  const blob = await drawCard(input);
  const file = new File([blob], `odin-${input.repo.replace("/", "-")}.png`, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: `Odin on ${input.repo}`, text: cardTitle(input.query), url: link });
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "shared";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
