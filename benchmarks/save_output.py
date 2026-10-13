import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.provenance import provenance  # noqa: E402

OUT = ROOT / "results" / "perf"


def gpu() -> str:
    try:
        import torch
    except ImportError:
        return ""
    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("script", type=Path)
    ap.add_argument("--label", required=True)
    args = ap.parse_args()
    out = OUT / f"{args.script.stem}_{args.label}.json"
    if out.exists():
        sys.exit(f"{out} exists; results are never overwritten, pick another --label")
    done = subprocess.run(
        [sys.executable, str(args.script)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
    )
    print(done.stdout)
    if done.returncode:
        sys.exit(done.stderr[-2000:])
    report = {
        "script": args.script.as_posix(),
        "output": done.stdout.splitlines(),
        "hardware": {
            "processor": platform.processor(),
            "logical_cores": os.cpu_count(),
            "gpu": gpu(),
            "platform": platform.platform(),
        },
        "provenance": provenance() | {"argv": sys.argv[1:]},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
