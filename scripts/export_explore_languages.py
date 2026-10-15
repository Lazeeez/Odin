import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "results" / "browser_ltr_multilang" / "explore"
TARGET = ROOT / "web" / "public" / "data" / "issues-multi"


def first_rank(ranked: list[str], gold: list[str]) -> int | None:
    wanted = set(gold)
    return next((i + 1 for i, u in enumerate(ranked) if u in wanted), None)


def summary_row(issue: dict) -> dict:
    stages = issue["functions"]
    final = stages.get("rerank") or stages.get("semantic") or []
    last = first_rank(final, issue["gold_functions"])
    keyword = first_rank(stages.get("keyword", []), issue["gold_functions"])
    title = issue["text"].replace("\r", "").strip().split("\n", 1)[0].strip()
    return {
        "id": issue["id"],
        "repo": issue["repo"],
        "language": "typescript" if issue["language"] == "tsx" else issue["language"],
        "title": title[:200],
        "first": last == 1,
        "missed": last is None,
        "rescued": keyword is None and last is not None,
    }


def main() -> int:
    files = sorted(SOURCE.glob("*.json"))
    if not files:
        sys.exit(f"no issues in {SOURCE}")
    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.mkdir(parents=True)
    rows = []
    for path in files:
        issue = json.loads(path.read_text(encoding="utf-8"))
        if not issue["gold_functions"]:
            continue
        (TARGET / path.name).write_text(
            json.dumps(issue, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
            newline="\n",
        )
        rows.append(summary_row(issue))
    rows.sort(key=lambda r: (r["language"], r["repo"], r["id"]))
    (TARGET / "index.json").write_text(
        json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n"
    )
    print(f"wrote {len(rows)} issues to {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
