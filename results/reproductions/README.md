# Reproductions

`swerank-embed-small_lite_2026-10-14.json` is SweRankEmbed-Small run with its authors' corpora, settings and evaluator. The variants below used the same corpora and evaluator through `scripts/swerank_cached_retrieval.py`; only the settings named differ. Numbers are the authors' evaluator's output on 274 issues, in %.

| Variant | File Acc@1 | File Acc@3 | File Acc@5 | Module Acc@5 | Module Acc@10 | Function Acc@5 | Function Acc@10 |
|---|---|---|---|---|---|---|---|
| documents 1,024 tokens, issue 1,024, path header (the authors' settings) | 67.15 | 87.23 | 91.24 | 79.20 | 85.04 | 63.50 | 74.82 |
| documents 1,024, issue 512 | 65.69 | 87.23 | 91.24 | 79.93 | 84.67 | 61.68 | 73.72 |
| documents 512, issue 1,024 | 65.33 | 87.23 | 91.61 | 79.93 | 85.40 | 61.31 | 74.45 |
| documents 512, issue 512 | 63.50 | 86.50 | 91.61 | 79.56 | 85.04 | 60.22 | 74.82 |
| documents 512, issue 512, header `Class.method` instead of the path | 57.30 | 82.85 | 86.13 | 74.09 | 79.93 | 54.38 | 64.96 |

The rankings of the variants were not kept in the repository; the commands that regenerate them are the script's options (`--sequence_length`, `--query_length`, `--header qualified-name`).
