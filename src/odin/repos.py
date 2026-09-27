from __future__ import annotations

import os
import subprocess
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path


class GitError(RuntimeError):
    pass


def _git(
    args: list[str],
    cwd: Path | None = None,
    input: bytes | None = None,
    env: dict[str, str] | None = None,
) -> bytes:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        input=input,
        capture_output=True,
        check=False,
        env={**os.environ, **env} if env else None,
    )
    if proc.returncode != 0:
        raise GitError(
            f"git {' '.join(args[:4])} failed: {proc.stderr.decode(errors='replace').strip()}"
        )
    return proc.stdout


# Report absent blobs instead of fetching them one round trip at a time.
_NO_LAZY_FETCH = {"GIT_NO_LAZY_FETCH": "1"}


@dataclass(frozen=True, slots=True)
class TreeEntry:
    path: str
    oid: str


class BlobReader:
    """One long-lived `git cat-file --batch` process; reading a blob is a pipe round trip."""

    def __init__(self, git_dir: Path) -> None:
        self._proc = subprocess.Popen(
            ["git", "cat-file", "--batch"],
            cwd=git_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._lock = threading.Lock()

    def read(self, oid: str) -> bytes:
        assert self._proc.stdin is not None and self._proc.stdout is not None
        with self._lock:
            self._proc.stdin.write(oid.encode() + b"\n")
            self._proc.stdin.flush()
            header = self._proc.stdout.readline().split()
            if len(header) != 3:
                raise GitError(f"cat-file: object {oid} unavailable")
            data = self._proc.stdout.read(int(header[2]))
            self._proc.stdout.read(1)
            return data

    def close(self) -> None:
        if self._proc.poll() is None:
            assert self._proc.stdin is not None
            self._proc.stdin.close()
            self._proc.wait()

    def __enter__(self) -> BlobReader:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class RepoCache:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def mirror_path(self, repo: str) -> Path:
        return self.root / f"{repo.replace('/', '__')}.git"

    def ensure_mirror(self, repo: str) -> Path:
        path = self.mirror_path(repo)
        if not (path / "HEAD").exists():
            _git(
                [
                    "clone",
                    "--bare",
                    "--filter=blob:none",
                    "--no-tags",
                    f"https://github.com/{repo}.git",
                    str(path),
                ]
            )
        return path

    def ensure_commit(self, repo: str, commit: str) -> Path:
        path = self.ensure_mirror(repo)
        try:
            _git(["cat-file", "-e", f"{commit}^{{commit}}"], cwd=path)
        except GitError:
            _git(["fetch", "--filter=blob:none", "origin", commit], cwd=path)
        return path

    def read_file(self, repo: str, commit: str, relpath: str) -> bytes:
        path = self.ensure_commit(repo, commit)
        return _git(["cat-file", "blob", f"{commit}:{relpath}"], cwd=path)

    def list_files(self, repo: str, commit: str) -> list[str]:
        return [e.path for e in self.list_tree(repo, commit)]

    def list_tree(self, repo: str, commit: str, suffix: str = "") -> list[TreeEntry]:
        """Every blob in the commit's tree. Trees are local in a blobless mirror, so no fetch."""
        path = self.ensure_commit(repo, commit)
        out = _git(
            ["ls-tree", "-r", "-z", "--format=%(objecttype) %(objectname) %(path)", commit],
            cwd=path,
        )
        entries = []
        for rec in out.decode("utf-8", "replace").split("\0"):
            if not rec.startswith("blob "):
                continue
            _, oid, relpath = rec.split(" ", 2)
            if relpath.endswith(suffix):
                entries.append(TreeEntry(relpath, oid))
        return entries

    def missing_blobs(self, repo: str, oids: Iterable[str]) -> list[str]:
        unique = list(dict.fromkeys(oids))
        if not unique:
            return []
        out = _git(
            ["cat-file", "--batch-check"],
            cwd=self.ensure_mirror(repo),
            input="\n".join(unique).encode() + b"\n",
            env=_NO_LAZY_FETCH,
        )
        return [line.split()[0] for line in out.decode().splitlines() if line.endswith(" missing")]

    def fetch_blobs(self, repo: str, oids: Iterable[str]) -> int:
        """Fetch exactly the missing blobs in one negotiation-free request."""
        missing = self.missing_blobs(repo, oids)
        if missing:
            _git(
                [
                    "-c",
                    "fetch.negotiationAlgorithm=noop",
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--recurse-submodules=no",
                    "--stdin",
                    "origin",
                ],
                cwd=self.ensure_mirror(repo),
                input="\n".join(missing).encode() + b"\n",
            )
        return len(missing)

    def prefetch_blobs(self, repo: str, specs: list[str]) -> int:
        """Prefetch `<commit>:<path>` specs. Best effort: reads fall back to lazy fetch."""
        path = self.ensure_mirror(repo)
        out = _git(
            ["cat-file", "--batch-check=%(objectname)"],
            cwd=path,
            input="\n".join(dict.fromkeys(specs)).encode() + b"\n",
            env=_NO_LAZY_FETCH,
        )
        oids = [line for line in out.decode().splitlines() if not line.endswith(" missing")]
        try:
            return self.fetch_blobs(repo, oids)
        except GitError:
            return 0

    def blob_reader(self, repo: str) -> BlobReader:
        return BlobReader(self.ensure_mirror(repo))

    def checkout(self, repo: str, commit: str, dest: Path) -> Path:
        path = self.ensure_commit(repo, commit)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            _git(["worktree", "add", "--detach", str(dest), commit], cwd=path)
        return dest
