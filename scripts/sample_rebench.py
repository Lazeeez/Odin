"""Pick the SWE-rebench bugs used to train and test the website's ranker.

    uv run python scripts/sample_rebench.py

150 random projects with at least 20 bugs each (none of SWE-bench's twelve, so SWE-bench
Lite stays untouched), up to 30 random bugs per project. Thirty projects are held out
entirely: "test" measures how the ranker does on projects it has never seen, which is what
the website faces. Seeded, and the result is committed, so the benchmark is reproducible.
"""

from __future__ import annotations

import json
import random
from collections import defaultdict

from odin.eval.dataset import DATASETS, REBENCH_SAMPLE, _rows

SEED = 0
N_REPOS, N_TEST_REPOS, MIN_BUGS, MAX_BUGS = 150, 30, 20, 30
SWE_BENCH_REPOS = {
    "astropy/astropy", "django/django", "matplotlib/matplotlib", "mwaskom/seaborn", "pallets/flask",
    "psf/requests", "pydata/xarray", "pylint-dev/pylint", "pytest-dev/pytest",
    "scikit-learn/scikit-learn", "sphinx-doc/sphinx", "sympy/sympy",
}  # fmt: skip


def touches_python(patch: str) -> bool:
    return any(
        line.startswith("diff --git") and line.rstrip().endswith(".py")
        for line in patch.splitlines()
    )


def main() -> None:
    by_repo: dict[str, list[str]] = defaultdict(list)
    for r in _rows(DATASETS["rebench"], "test", parts=2):
        if r["repo"] not in SWE_BENCH_REPOS and touches_python(r["patch"]):
            by_repo[r["repo"]].append(r["instance_id"])
    eligible = sorted(repo for repo, ids in by_repo.items() if len(ids) >= MIN_BUGS)
    rng = random.Random(SEED)
    repos = rng.sample(eligible, N_REPOS)
    test_repos = sorted(repos[:N_TEST_REPOS])
    train_repos = sorted(repos[N_TEST_REPOS:])
    pick = {
        repo: sorted(rng.sample(sorted(by_repo[repo]), min(MAX_BUGS, len(by_repo[repo]))))
        for repo in repos
    }
    out = {
        "source": DATASETS["rebench"], "seed": SEED, "eligible_repos": len(eligible),
        "train_repos": train_repos, "test_repos": test_repos,
        "train": [i for r in train_repos for i in pick[r]],
        "test": [i for r in test_repos for i in pick[r]],
    }  # fmt: skip
    REBENCH_SAMPLE.parent.mkdir(parents=True, exist_ok=True)
    REBENCH_SAMPLE.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"{len(eligible)} eligible projects; train {len(out['train'])} bugs in {len(train_repos)} projects,"
          f" test {len(out['test'])} bugs in {len(test_repos)} projects -> {REBENCH_SAMPLE}")  # fmt: skip


if __name__ == "__main__":
    main()
