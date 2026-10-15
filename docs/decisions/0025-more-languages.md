# 0025: Searching code in languages other than Python

## Status

Accepted, 2026-10-15. The data, the splits and the decision rule were fixed before any multi-language data was built. Outcomes are added per phase.

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
- **The Benchmarks page reports every language's held-out numbers,** whatever they are, next to the bug counts behind them.

### Not in scope

The GPU pipeline (odin-fast and odin-max) stays Python-only; its benchmarks are Python benchmarks. This ADR is about the website.

## Consequences

- Grammars are loaded only for the languages a repository contains, from the site itself (0.2 to 1.5 MB each for phase 1, gzipped smaller), and cached.
- The site's headline numbers stay Python's until each language has its own held-out number; no number from one language is quoted for another.
