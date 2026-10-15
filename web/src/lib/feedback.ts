import type { RankStage } from "../worker/protocol.ts";

export type QuerySource = "typed" | "preset" | "issue" | "link";

export interface Usage {
  searches: number;
  repos: number;
  since: string | null;
  up: number;
  down: number;
}

const API = (import.meta.env.VITE_API as string | undefined)?.replace(/\/+$/, "") ?? "";

export const feedbackEnabled = API !== "";

export const newSession = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const privacySignal = (): boolean => {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
};

async function post(path: string, body: unknown): Promise<boolean> {
  if (!feedbackEnabled) return false;
  try {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function recordSearch(repo: string, source: QuerySource, stage: RankStage, session: string): void {
  if (privacySignal()) return;
  void post("/search", { repo, source, stage, session });
}

export function recordVote(vote: {
  repo: string; sha: string | null; unit: string; rank: number; vote: 1 | -1; stage: RankStage; issue: string | null; session: string;
}): Promise<boolean> {
  return post("/vote", vote);
}

export async function fetchUsage(): Promise<Usage | null> {
  if (!feedbackEnabled) return null;
  try {
    const response = await fetch(`${API}/stats`);
    return response.ok ? ((await response.json()) as Usage) : null;
  } catch {
    return null;
  }
}

export interface LiveWindow {
  bugs: number;
  projects: number;
  function?: { "hit@10": number; "hit@1": number; "recall@10": number; mrr: number; "hit@10_ci95": [number, number] };
  file?: { "hit@10": number; "hit@10_ci95": [number, number] };
  merged?: [string, string];
}

export interface LiveSummary {
  generated: string;
  last_30_days: LiveWindow;
  all_time: LiveWindow;
  all_time_trained_projects?: LiveWindow;
  all_time_new_projects?: LiveWindow;
  last_30_days_by_language?: Record<string, LiveWindow>;
  history?: { date: string; scored: number; last_30_days: LiveWindow }[];
}

export const LIVE_MIN_BUGS = 30;

export async function fetchLive(): Promise<LiveSummary | null> {
  if (!feedbackEnabled) return null;
  try {
    const response = await fetch(`${API}/live`);
    return response.ok ? ((await response.json()) as LiveSummary) : null;
  } catch {
    return null;
  }
}
