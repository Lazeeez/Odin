export const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
export const fixed3 = (x: number): string => x.toFixed(3);
export const metricLabel = (metric: string, x: number): string => (metric === "mrr" ? fixed3(x) : pct(x));

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** `code` spans in trusted, hand-written copy (never in user or repository text). */
export const inlineCode = (s: string): string => escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");
