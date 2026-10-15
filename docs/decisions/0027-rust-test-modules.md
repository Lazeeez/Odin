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
