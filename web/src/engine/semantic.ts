// The embedding model behind the browser's second ranking stage (engine/rank.ts).
// Depth 20: the learned ranker's top 20 are embedded per query (scripts/browser_ltr.py DEPTH).
// Embedding 50 gained 0.4 points of CV hit@10 for 2.5x the work; 128 tokens instead of 256 lost more.
export const SEMANTIC = { model: "Xenova/all-MiniLM-L6-v2", depth: 20, maxTokens: 256 } as const;

/** Results returned per search (the list the page shows), independent of the embedding depth. */
export const RESULTS = 50;

export type Embed = (texts: string[]) => Promise<Float32Array[]>;

/** The text a unit is embedded as, identical to Odin's unit_text(). */
export const unitText = (u: { qualname: string; text: string }): string => `${u.qualname}\n${u.text}`;
