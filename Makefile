RETRIEVER ?= bm25-code-notests
LEVEL ?= function
DATASET ?= lite
A ?= results/bm25-code_function_lite_test.json
B ?= results/bm25-code-notests_function_lite_test.json

.PHONY: setup setup-dense gold eval ablations dense tune tune-fusion ltr reranker final bench compare test check-readme parity lint fmt web-dev web-check web-data

setup:
	uv sync

setup-dense:
	uv sync --extra dense

gold:
	uv run odin gold --dataset $(DATASET)

eval:
	uv run odin eval --retriever $(RETRIEVER) --level $(LEVEL) --dataset $(DATASET)

# Every row of the README results table.
ablations:
	for r in bm25-naive bm25-code bm25-code-notests; do \
		for l in file function; do uv run odin eval --retriever $$r --level $$l || exit 1; done; \
	done
	uv run odin eval --retriever bm25-code-notests-graph --level function

# Dense and hybrid rows (needs `make setup-dense`; first run embeds ~185k units).
dense:
	for r in dense-notests hybrid-notests; do \
		for l in file function; do uv run odin eval --retriever $$r --level $$l || exit 1; done; \
	done

# Tune on SWE-bench Verified minus Lite; never on the Lite test set.
tune:
	uv run odin gold --dataset verified
	uv run odin tune --exclude-tests

tune-fusion:
	uv run odin tune --what fusion

# Learned rankers, trained on SWE-bench test minus Lite (never on Lite).
ltr:
	uv run odin gold --dataset full
	uv run odin ltr

# The two ensemble members: v1 on hybrid's hard negatives, v2 on out-of-fold LTR negatives.
reranker:
	uv run odin ce-train --negatives hybrid --epochs 1 --data results/ce_train_hybrid_negatives.jsonl --out models/ce_adapter_v1
	uv run odin ce-train --negatives ltr --epochs 2 --out models/ce_adapter
	uv run odin ce-tune --adapter models/ce_adapter_v1 models/ce_adapter --out models/reranker.json

# Website (web/): dev server, checks, production build, data refresh.
web-dev:
	npm --prefix web run dev

web-check:
	npm --prefix web run typecheck && npm --prefix web test && npm --prefix web run build

web-data:
	uv run python scripts/export_site.py
	uv run --extra dense python scripts/browser_ltr.py
	uv run python scripts/export_showcase.py

final:
	for l in file function; do uv run odin eval --retriever ltr-ce-notests --level $$l || exit 1; done

bench:
	uv run python benchmarks/bench_batching.py
	uv run --with faiss-cpu python benchmarks/bench_search.py

compare:
	uv run odin compare $(A) $(B)

test:
	uv run pytest -q

check-readme:
	uv run python scripts/check_readme.py

parity:
	uv run python scripts/parity_run.py --check

lint:
	uv run ruff check src tests benchmarks scripts
	uv run ruff format --check src tests benchmarks scripts

fmt:
	uv run ruff check --fix src tests benchmarks scripts
	uv run ruff format src tests benchmarks scripts
