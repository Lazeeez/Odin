# Contributing

Issues and pull requests are welcome. A bug report is most useful with the repository you searched, the query, and what you expected to find.

## Setup

```sh
uv sync                    # the engine; add --extra dense for embeddings and the reranker
cd web && npm ci           # the website (Node 24)
```

## Before opening a pull request

```sh
make test                  # Python tests
make lint                  # ruff check and format
make check-readme          # every number in the README against the committed result files
make web-check             # typecheck, unit tests and build of the website
cd web && npm run e2e      # end-to-end in Chromium, Firefox and WebKit, after npm run build
```

CI runs the same checks.

## Rules that are not negotiable

1. **Nothing is tuned on a test set.** Settings are chosen on the dev split or by project-grouped cross-validation. SWE-bench Lite and the 30 unseen projects are for reporting only, and every evaluation on them is appended to [results/test-evals.log](results/test-evals.log).
2. **The holdout is sealed.** `odin eval --dataset holdout` runs only for the configurations in `data/holdout/allowed.json`, once each. No holdout project may enter a training or dev set. See [ADR 0013](docs/decisions/0013-sealed-holdout.md).
3. **A claim needs a paired bootstrap.** `odin compare a.json b.json` prints the difference, its 95% interval, the p-value, and wins and losses. A difference that is not significant is reported as not significant.
4. **Results are never overwritten.** A new run writes a new file; result files carry their provenance (commit, library versions, model hashes, command line).
5. **Numbers come from files.** A number in the README or an ADR must be recomputable from a committed result file. A number from another system cites its paper's table, or says it was reproduced here.
6. **Latency names its hardware.**

## Style

- One change per commit, with a message that says what changed.
- A decision with alternatives gets an ADR in [docs/decisions/](docs/decisions/), including decisions that did not work out.
- New code carries no comments; names and ADRs do the explaining. Existing comments stay.
- The website's Python and TypeScript engines must agree: `make parity` and the tests in `tests/test_site_engine.py` check it.

## Licences

The code is MIT. Datasets and models keep their own licences, listed in [data/LICENSES.md](data/LICENSES.md). By contributing you agree that your contribution is released under the MIT licence.
