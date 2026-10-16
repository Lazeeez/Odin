export interface ConfidenceModel {
  features: string[];
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

export interface Scored {
  score: number;
  row: number;
  x: ArrayLike<number>;
}

export type Band = "high" | "medium" | "low";

export function confidenceFeatures(candidates: readonly Scored[], featureNames: readonly string[], text: string): number[] {
  const chars = Array.from(text).length;
  if (!candidates.length) return [0, 0, 0, 0, 0, 0, 0, 0, 0, Math.log1p(chars)];
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.row - b.row).slice(0, 10);
  const top = sorted.map((c) => c.score);
  const e = top.map((s) => Math.exp(s - top[0]));
  const total = e.reduce((a, b) => a + b, 0);
  const p = e.map((v) => v / total);
  const col = (name: string) => featureNames.indexOf(name);
  const present = (...names: string[]) => (sorted.some((c) => names.some((n) => c.x[col(n)] > 0)) ? 1 : 0);
  return [
    top[0],
    top[0] - (top.length > 1 ? top[1] : top[0]),
    top[0] - top[top.length - 1],
    p[0],
    -p.reduce((a, v) => a + v * Math.log(v), 0),
    Math.log1p(candidates.length),
    present("frame_name", "frame_both"),
    present("qual_mentioned", "name_in_code"),
    present("path_mentioned", "module_mentioned"),
    Math.log1p(chars),
  ];
}

export function confidence(model: ConfidenceModel, features: readonly number[]): number {
  let z = model.bias;
  features.forEach((v, i) => {
    z += ((v - model.mean[i]) / model.std[i]) * model.weights[i];
  });
  return 1 / (1 + Math.exp(-z));
}

export const band = (p: number): Band => (p >= 0.8 ? "high" : p >= 0.5 ? "medium" : "low");
