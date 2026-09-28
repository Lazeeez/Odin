"""Pick the landing page's example searches from the evaluation run.

Real SWE-bench Lite issues where the full pipeline ranked a function the maintainers' fix changed
first, with a short title and an error or code line to show. Each entry keeps the pipeline's
actual top 4 from the run and which of them the fix changed. Deterministic: rerun after
export_site.py refreshes web/public/data/.

    uv run python scripts/export_showcase.py
"""

import json
import re
from collections import Counter
from itertools import zip_longest
from pathlib import Path

DATA = Path("web/public/data/issues")
OUT = Path("web/src/assets/showcase.json")
STAGE = "ltr-ce-notests"
N, PER_REPO, TOP = 24, 4, 4
EVIDENCE = re.compile(r"(Error|Exception|Traceback|Warning|>>>|`[^`]+`)")


def snippet(body: str) -> str | None:
    """The first line of the report that reads like evidence: an error, a prompt or quoted code."""
    for line in body.splitlines():
        line = re.sub(r"\s{2,}", " ", line.strip().strip("`").strip())
        if 12 <= len(line) <= 140 and EVIDENCE.search(line) and not line.startswith(("http", "#")):
            return line
    return None


def main() -> None:
    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    picked, per_repo = [], Counter()
    for item in sorted(index, key=lambda i: i["id"]):
        if not item["first"] or len(item["title"]) > 80 or per_repo[item["repo"]] >= PER_REPO:
            continue
        issue = json.loads((DATA / f"{item['id']}.json").read_text(encoding="utf-8"))
        text = issue["text"].replace("\r", "")
        body = text.split("\n", 1)[1] if "\n" in text else ""
        code = snippet(body)
        top = issue["functions"].get(STAGE, [])[:TOP]
        gold = set(issue["gold_functions"])
        if not code or len(top) < TOP or top[0] not in gold:
            continue
        picked.append({
            "id": item["id"], "repo": item["repo"], "title": item["title"], "code": code,
            "top": [[u.split("::", 1)[1], u.split("::", 1)[0], u in gold] for u in top],
        })  # fmt: skip
        per_repo[item["repo"]] += 1
    # spread across projects: round-robin by repository
    by_repo: dict[str, list] = {}
    for p in picked:
        by_repo.setdefault(p["repo"], []).append(p)
    rounds = zip_longest(*by_repo.values())
    out = [x for group in rounds for x in group if x is not None][:N]
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(out)} examples from {len({p['repo'] for p in out})} projects to {OUT}")


if __name__ == "__main__":
    main()
