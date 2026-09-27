import subprocess

import pytest

from odin.repos import RepoCache


def _git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def local_repo(tmp_path):
    """Two commits of a tiny package, published as a bare mirror inside a RepoCache."""
    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "-q")
    _git(work, "config", "user.email", "t@t")
    _git(work, "config", "user.name", "t")
    (work / "pkg").mkdir()
    (work / "pkg" / "auth.py").write_text(
        "class Session:\n    def login(self, password):\n        return verify_password(password)\n"
    )
    (work / "pkg" / "render.py").write_text("def render_template(name):\n    return name\n")
    _git(work, "add", ".")
    _git(work, "commit", "-qm", "one")
    first = _git(work, "rev-parse", "HEAD")
    (work / "pkg" / "render.py").write_text(
        "def render_template(name):\n    return escape_html(name)\n"
    )
    _git(work, "commit", "-qam", "two")
    second = _git(work, "rev-parse", "HEAD")

    cache = RepoCache(tmp_path / "cache")
    _git(tmp_path, "clone", "-q", "--bare", str(work), str(cache.mirror_path("acme/pkg")))
    return cache, first, second
