# 0027: Rust test modules are test code

## Status

Accepted, 2026-10-16. Written before the answer keys were rebuilt or the rankers retrained.

## Context

Odin leaves tests out of the search by default, in training, in the answer keys and on the website, and it recognises them by path: `tests/`, `*_test.go`, `*.test.ts`, `src/test/` in Java ([ADR 0025](0025-more-languages.md)). Rust keeps most unit tests in the file they test, inside a module marked `#[cfg(test)]` and conventionally named `tests`. A path rule cannot see them, so their functions are candidates like any other. On the live site, searching `BurntSushi/ripgrep` for a glob bug put `tests.descendants_of_hidden_directories_are_ignored` first.

## Decision

- **In Rust, a module named `tests` or `test`, or one preceded by a `#[cfg(test)]` attribute (among any attributes stacked on it), is not walked**: none of its functions, types or nested modules become units. The rule is in the symbol extractor of both engines, so it holds for the index, the answer keys and the browser alike, and the parity tests cover it.
- It applies whether or not tests are included. These modules are compiled only for tests, so no fix to the program lives in them; a visitor who switches tests on still sees `tests/` files.
- **Consequences for the data:** the multi-language answer keys are rebuilt (a fix that also edited an inline test no longer counts that test as a target), and the multi-language rankers are retrained with the same code, seed and settings.
- **Decision rule:** this is a definition, adopted because it is correct, not because of a score. The retrained ranker ships if ADR 0025's rule still holds for every language in cross-validation. The held-out sets are scored again because the units changed; that run is logged in `results/test-evals.log` and decides nothing.

## Consequences

- Visitors' cached multi-language repositories are re-parsed once (the cache key changed).
- Other languages keep tests in separate files, which the path rules already handle.

## Outcome

Measured 2026-10-16 on PACE. Results: [report.json](../../results/browser_ltr_multilang/report.json), with its [provenance](../../results/browser_ltr_multilang/provenance.json).

**The rule holds for every language, so the retrained ranker ships.**

- **Answer keys:** 32 Rust bugs changed (30 in training, 2 in SWE-bench Multilingual), each losing inline test functions from its answer; every one still has a function to find, so the held-out sets keep their sizes (161 and 340). No other language's keys changed.
- **Cross-validation, learned ranker against keywords and meaning (function hit@10):** Python 78.4% vs 65.7%, Go 70.2% vs 56.2%, Java 61.5% vs 38.8%, JavaScript 71.0% vs 57.3%, TypeScript 59.0% vs 39.4%, Rust 73.3% vs 54.2% (120 bugs); every gain is 12.7 to 22.7 points with p < 0.0001.
- **Held out, final in-browser stage, decided nothing:** Lite 69.1% (unchanged), the 30 unseen projects 76.4% (76.3% before), SWE-bench Multilingual 67.1% (64.6%), SWE-PolyBench 70.6% (68.2%).
- **A run was interrupted on the way.** The first retrain reused cached builds made before the rule changed; the rule shrinks the unit index of any repository containing Rust files, so their stored row positions no longer matched, and the run stopped with an index error on SWE-PolyBench. Its three completed held-out runs are logged; the rerun rebuilt every stale cache and is the result above.
