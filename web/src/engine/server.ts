export const SERVER = { depth: 50, weight: 1, maxChars: 8000, timeoutMs: 90_000, settleMs: 500, skipLanguageModel: true } as const;

export class ServerUnavailable extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

const z = (x: number[]): number[] => {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const std = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length);
  return std > 0 ? x.map((v) => (v - mean) / std) : x.map(() => 0);
};

export function blend<T>(items: T[], scores: number[][], depth: number = SERVER.depth, weight: number = SERVER.weight): T[] {
  const n = Math.min(depth, items.length, ...scores.map((s) => s.length));
  if (!scores.length || n < 2) return items;
  const members = scores.map((s) => z(s.slice(0, n)));
  const base = z(Array.from({ length: n }, (_, i) => -Math.log1p(i + 1)));
  const combined = base.map((b, i) => b + weight * (members.reduce((a, m) => a + m[i], 0) / members.length));
  const order = combined.map((_, i) => i).sort((i, j) => combined[j] - combined[i] || i - j);
  return [...order.map((i) => items[i]), ...items.slice(n)];
}

export async function serverScores(endpoint: string, query: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const body = JSON.stringify({ query: query.slice(0, SERVER.maxChars), texts: texts.slice(0, SERVER.depth).map((t) => t.slice(0, SERVER.maxChars)) });
  const timeout = AbortSignal.timeout(SERVER.timeoutMs);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch((err: unknown) => {
    if (signal?.aborted) throw err;
    throw new ServerUnavailable("no answer from the GPU server");
  });
  if (response.status === 501 || response.status === 404) throw new ServerUnavailable("not set up on this site", true);
  if (response.status === 429) throw new ServerUnavailable("too many requests from this address; try again in a minute");
  if (!response.ok) throw new ServerUnavailable("the GPU server did not answer");
  const out = (await response.json()) as { scores?: number[][] };
  if (!Array.isArray(out.scores) || !out.scores.length) throw new ServerUnavailable("the GPU server sent an unexpected answer");
  return out.scores;
}
