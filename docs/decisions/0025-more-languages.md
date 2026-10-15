# 0025: Searching code in languages other than Python

## Status

Accepted, 2026-10-15. The data, the splits and the decision rule were fixed before any multi-language data was built. Phase 1 is measured and shipped; its outcome is below.

## Context

The website reads Python only: its chunker splits Python with Tree-sitter, and every ranker was trained on Python bugs (SWE-bench, SWE-rebench). A visitor asking about a theme toggle in a TypeScript front end gets Python functions that share a word with the report, because the code they mean was never searched. Since 2026-10-15 the site says so ([`web/src/engine/languages.ts`](../../web/src/engine/languages.ts)); this ADR is about searching that code.

Public data now covers other languages with real bugs and the code their fixes changed:

| Dataset | Languages | Licence | Role here |
|---|---|---|---|
| Multi-SWE-RL (ByteDance-Seed) | C, C++, Go, Java, JavaScript, Rust, TypeScript | CC0 | training |
| SWE-bench Multilingual | C, C++, Go, Java, JavaScript, PHP, Ruby, Rust, TypeScript | MIT | held-out test |
| SWE-PolyBench 500 | Java, JavaScript, TypeScript, Python | MIT | held-out test |

## Decision

### Languages, in two phases

- **Phase 1:** JavaScript, TypeScript (with JSX and TSX), Go, Java and Rust: each has training data and held-out bugs in both test sets or one of them.
- **Phase 2:** C, C++, Ruby, PHP and C#, after phase 1 is measured. Ruby and PHP have test data but no training data; they would run on rankers trained on the other languages, and their numbers say so.
- Python is unchanged.

### What a unit is

As for Python, a unit is a function, a method or a class-like definition, named by its path and qualified name:

| Language | Units |
|---|---|
| JavaScript, TypeScript | function declarations, methods, classes, interfaces, type aliases and enums (TypeScript), and functions or arrow functions bound to a name (`const Toggle = () => …`), which is how most React components are written |
| Go | functions, methods (named `Receiver.Method`), and type declarations |
| Java | classes, interfaces, enums, records, methods and constructors |
| Rust | functions, methods in `impl` blocks (named `Type.method`), structs, enums and traits |

Each language's rules are written once for the Python engine and once for the browser, and a parity test requires the two to agree unit for unit, as for Python today.

### Ground truth

The same method as for Python: a fix's diff, mapped at its base commit onto the units whose lines it changes. Test files are excluded by each language's conventions (`*.test.ts`, `*.spec.js`, `__tests__/`, `*_test.go`, `src/test/` in Java, `tests/` in Rust, and the existing rules).

### Data and splits

- **Training:** Multi-SWE-RL's phase-1 languages, minus every repository that appears in either test set, plus the existing Python training data. Every choice (features, rounds, which stages ship for a language) is made by cross-validation grouped by project.
- **Held out, run once per phase:** the phase-1 languages of SWE-bench Multilingual and of SWE-PolyBench 500, minus any repository in the training data. The number of bugs dropped for overlap is reported. Both runs are logged in `results/test-evals.log`.

### Decision rule

Fixed before looking, per language:

- **The website searches a language** once its chunker passes the parity test. That alone makes the code searchable by keywords and meaning.
- **The learned ranker is used for that language** if, in cross-validation, its function hit@10 on that language is better than keyword-and-meaning ranking alone by at least 2 points with p < 0.05 (paired bootstrap over issues). Otherwise the site ranks that language by the simpler signal and says so.
- **"Keyword-and-meaning ranking alone"** is fixed here, before any cross-validation: within the same candidate pool, each unit scores z(BM25 over the issue) + z(static-embedding cosine to the issue), z-scored over the pool, equal weights, nothing tuned. It is computed from the same cross-validated items as the learned ranker.
- **Cross-validation** is grouped by project over all training projects (Python's and the new languages' together), five folds, seeded; the per-language comparison uses each language's out-of-fold rankings.
- **Mentions** (stack traces, source paths, module names) are parsed in multi-language mode for every issue, Python's included, in the website's rankers only; the GPU pipeline keeps its Python-only parsing.
- **The Benchmarks page reports every language's held-out numbers,** whatever they are, next to the bug counts behind them.

### Not in scope

The GPU pipeline (odin-fast and odin-max) stays Python-only; its benchmarks are Python benchmarks. This ADR is about the website.

## Consequences

- Grammars are loaded only for the languages a repository contains, from the site itself (0.2 to 1.5 MB each for phase 1, gzipped smaller), and cached.
- The site's headline numbers stay Python's until each language has its own held-out number; no number from one language is quoted for another.

## Outcome, phase 1

Measured 2026-10-15 on PACE. Results: [report.json](../../results/browser_ltr_multilang/report.json) (the cross-validation per language and every issue's result), and the site's copy in [lite.json](../../web/public/data/lite.json).

**Every phase-1 language passes the rule, so the website ranks all six languages with the learned ranker.**

Training: 7,845 issues from 192 projects, 5,115 of them Python from 131 projects and 2,730 from 61 Multi-SWE-RL projects. Answer keys were built twice, on PACE and on a laptop, and matched byte for byte.

| Cross-validation, by language | Issues | Projects | Learned ranker | Keywords and meaning | Gain, hit@10 |
|---|---|---|---|---|---|
| Python | 5,115 | 131 | 78.6% | 65.7% | +12.9 [11.9, 14.1] |
| Go | 816 | 14 | 69.6% | 56.2% | +13.4 [10.4, 16.4] |
| Java | 768 | 11 | 62.4% | 38.8% | +23.6 [20.2, 27.1] |
| TypeScript | 586 | 18 | 57.2% | 39.4% | +17.7 [14.2, 21.3] |
| JavaScript | 438 | 18 | 69.6% | 57.3% | +12.3 [8.2, 16.4] |
| Rust | 122 | 10 | 73.8% | 52.5% | +21.3 [13.1, 29.5] |

Every gain clears 2 points with p < 0.0001 (paired bootstrap over issues).

Held out, run once (the run was repeated with the same seed, data and code to label issues by language, and every total matched; both runs are in `results/test-evals.log`):

| Language | Test set | Bugs | Learned ranker | Keywords and meaning | Gain, hit@10 |
|---|---|---|---|---|---|
| Go | SWE-bench Multilingual | 37 | 62.2% | 46.0% | +16.2 (p = 0.026) |
| Java | SWE-bench Multilingual | 43 | 76.7% | 67.4% | +9.3 (p = 0.13) |
| JavaScript | SWE-bench Multilingual | 26 | 57.7% | 50.0% | +7.7 (p = 0.44) |
| Rust | SWE-bench Multilingual | 41 | 63.4% | 48.8% | +14.6 (p = 0.099) |
| TypeScript | SWE-bench Multilingual | 14 | 50.0% | 21.4% | +28.6 (p = 0.016) |
| Java | SWE-PolyBench | 125 | 67.2% | 55.2% | +12.0 (p < 0.001) |
| JavaScript | SWE-PolyBench | 115 | 77.4% | 55.6% | +21.7 (p < 0.001) |
| TypeScript | SWE-PolyBench | 100 | 59.0% | 44.0% | +15.0 (p < 0.001) |

- **Every held-out gain is positive;** the smaller SWE-bench Multilingual sets are not significant on their own, as expected at 14 to 43 bugs.
- **Python moved by under a point:** on the 30 unseen projects, function hit@10 is 77.0% after the semantic stage and 76.3% after the MiniLM stage, against 77.2% for the Python-only ranker; files 94.2% against 94.4%. On Lite, 69.1% either way. The Python-only ranker's per-issue results were not kept, so this is not tested for significance.
- **Fixed on the way:** 9 Lucene bugs failed to parse (Python's recursion limit on deeply nested Java), so both engines now walk syntax trees with an explicit stack, in the same order; one issue had 19,484 candidates, over LightGBM's limit for a query, so training keeps each issue's gold and best keyword matches up to 10,000; the browser indexed a file's extension as a path word for non-Python files where training did not, now fixed and covered by a parity test on TypeScript files.
- **Phase 2** (C, C++, Ruby, PHP, C#) is not started.
