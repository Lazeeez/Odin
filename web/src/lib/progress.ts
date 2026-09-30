/**
 * Where each loading phase sits on one overall 0..1 scale, so a load's progress only moves
 * forward: listing is quick, downloading and parsing is nearly all of it, indexing is the end.
 * The phase names are the ones engine/repo.ts reports.
 */
const PHASES: Record<string, [from: number, to: number]> = {
  "Listing files": [0, 0.05],
  "Downloading and parsing": [0.05, 0.95],
  "Building the index": [0.95, 1],
};

export function overallProgress(phase: string, done: number, total: number): number {
  const [from, to] = PHASES[phase] ?? [0, 1];
  return from + (to - from) * (total > 0 ? Math.min(1, done / total) : 0);
}
