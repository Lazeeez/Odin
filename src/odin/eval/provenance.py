from __future__ import annotations

import hashlib
import platform
import subprocess
import sys
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

_PACKAGES = ("numpy", "scipy", "tree-sitter", "lightgbm", "torch", "sentence-transformers")


def _git(*args: str) -> str:
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.exists() else "missing"


def provenance(model_files: list[Path] | None = None) -> dict:
    """Everything needed to say exactly which code, data and models produced a result."""
    versions = {}
    for p in _PACKAGES:
        try:
            versions[p] = version(p)
        except PackageNotFoundError:
            continue
    return {
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_commit": _git("rev-parse", "HEAD"),
        "git_dirty": bool(_git("status", "--porcelain", "--untracked-files=no")),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "packages": versions,
        "models": {str(p): _file_digest(p) for p in model_files or []},
    }
