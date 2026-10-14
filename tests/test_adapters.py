import hashlib
import json
from pathlib import Path

import pytest

MODELS = Path("models")
MANIFEST = json.loads((MODELS / "adapters.json").read_text(encoding="utf-8"))
LOCAL_FOLDER = {"v1": "ce_adapter_v1", "v2": "ce_adapter"}


def digest(path: Path) -> str:
    data = path.read_bytes()
    if path.suffix == ".json":
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def test_the_published_ensemble_settings_are_the_committed_ones():
    assert digest(MODELS / "reranker.json") == MANIFEST["files"]["reranker.json"]["sha256"]


def test_the_manifest_covers_every_adapter_the_ensemble_uses():
    used = json.loads((MODELS / "reranker.json").read_text(encoding="utf-8"))["adapters"]
    assert sorted(used) == sorted(f"models/{folder}" for folder in LOCAL_FOLDER.values())
    for version in LOCAL_FOLDER:
        assert f"{version}/adapter_model.safetensors" in MANIFEST["files"]


@pytest.mark.parametrize("version", sorted(LOCAL_FOLDER))
def test_local_adapter_weights_match_the_manifest(version):
    weights = MODELS / LOCAL_FOLDER[version] / "adapter_model.safetensors"
    if not weights.exists():
        pytest.skip("adapter weights are not committed; `make adapters` downloads them")
    assert digest(weights) == MANIFEST["files"][f"{version}/adapter_model.safetensors"]["sha256"]


def test_a_pinned_revision_accompanies_a_published_repo():
    assert bool(MANIFEST["repo"]) == bool(MANIFEST["revision"])
