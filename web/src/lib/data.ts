// Shapes of the JSON written by scripts/export_site.py and scripts/browser_ltr.py.

export interface Stage {
  level: "function" | "file";
  id: string;
  label: string;
  blurb: string;
  n: number;
  "recall@1": number;
  "recall@5": number;
  "recall@10": number;
  "hit@1": number;
  "hit@5": number;
  "hit@10": number;
  mrr: number;
  ci95: Record<string, [number, number]>;
  latency_ms_p50: number | null;
  by_repo: Record<string, { n: number; "recall@10": number; mrr: number }>;
}

export interface PairedTest {
  delta: number;
  ci95: [number, number];
  p: number;
  wins: number;
  losses: number;
}

export interface Summary {
  stages: Stage[];
  significance: Record<string, Record<"recall@1" | "recall@10" | "mrr", PairedTest>>;
}

export interface Issue {
  id: string;
  repo: string;
  text: string;
  gold_files: string[];
  gold_functions: string[];
  functions: Record<string, string[]>;
  files: Record<string, string[]>;
}

/** One row of data/issues/index.json: enough to list and filter without the rankings. */
export interface IssueSummary {
  id: string;
  repo: string;
  title: string;
  rescued: boolean;
  first: boolean;
  missed: boolean;
}

/** The in-browser pipeline on SWE-bench Lite, held out (scripts/browser_ltr.py). */
export interface Lite {
  embedder: string;
  depth: number;
  lite: { keyword: Record<string, number>; stage1: Record<string, number>; stage2?: Record<string, number> };
}

export type Metric = "hit@1" | "hit@5" | "hit@10" | "recall@10" | "mrr";

const base = import.meta.env.BASE_URL;

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const stagesAt = (s: Summary, level: Stage["level"]) => s.stages.filter((x) => x.level === level);
