/**
 * Plain-English names for the pipeline's stages, for readers who don't know BM25 from LambdaMART.
 * The technical label from the data stays available beside them.
 */
export const PLAIN: Record<string, [name: string, what: string]> = {
  "bm25-naive": ["Plain keyword search", "Matches the words in the report, like a basic search box."],
  "bm25-code-notests": ["Code-aware keywords", "Knows get_queryset is “get” + “queryset”, and skips test files."],
  "hybrid-notests": ["Keywords + meaning", "Adds an AI model that matches what the report means, not only its words."],
  "ltr-notests": ["Learned ranking", "A model trained on thousands of past bugs weighs dozens of clues."],
  "ltr-ce-notests": ["Language-model check", "A fine-tuned language model re-reads the best candidates, the way a developer would."],
};

export const plainName = (id: string, fallback: string) => PLAIN[id]?.[0] ?? fallback;
export const plainWhat = (id: string) => PLAIN[id]?.[1] ?? "";
