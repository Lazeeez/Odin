import json
import re
import sys
import tomllib
from pathlib import Path


def name_of(requirement: str) -> str:
    return re.split(r"[<>=!~\[ ;]", requirement, maxsplit=1)[0].strip().lower().replace("_", "-")


def main() -> int:
    root, manifest_path = Path(sys.argv[1]), Path(sys.argv[2])
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    environment = json.loads(manifest_path.read_text(encoding="utf-8")).get("environment", {})
    replaced = {name_of(r) for r in environment.get("with", [])}
    dropped = {name.lower() for name in environment.get("without", [])}
    declared = project["dependencies"] + project["optional-dependencies"]["dense"]
    kept = [r for r in declared if name_of(r) not in replaced | dropped]
    print("\n".join(kept + environment.get("with", [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
