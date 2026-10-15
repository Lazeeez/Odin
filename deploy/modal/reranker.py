import hashlib
from pathlib import Path

import modal

BASE = "Qwen/Qwen3-Reranker-0.6B"
BASE_REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
ADAPTERS = "lazeeez/odin-reranker-adapters"
ADAPTERS_REVISION = "0117dc4fe2c7260fc7d7684c47787e652a840012"
MEMBERS = ("v1", "v2")
WEIGHTS = {
    "v1/adapter_model.safetensors": "91246a13d417d71e01b2f24a7b35bfc46c51f231ac2ae2728761499604d603b9",
    "v2/adapter_model.safetensors": "9ce9bafbf4c21b80a89a99557871792b07ac5368528eb151f48be0cb021e08a0",
}
MAX_TEXTS = 50
MAX_CHARS = 8000
CROSS_ENCODER = Path(__file__).resolve().parent.parent.parent / "src/odin/rank/cross_encoder.py"


def download() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(BASE, revision=BASE_REVISION)
    root = Path(
        snapshot_download(ADAPTERS, revision=ADAPTERS_REVISION, allow_patterns=["v1/*", "v2/*"])
    )
    for name, digest in WEIGHTS.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"{name} does not match models/adapters.json")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.14.0",
        "transformers==5.17.0",
        "peft==0.21.0",
        "accelerate==1.15.0",
        "safetensors==0.8.0",
        "huggingface-hub==1.33.0",
        "numpy==2.4.6",
        "fastapi[standard]",
    )
    .run_function(download)
    .env({"HF_HUB_OFFLINE": "1"})
    .add_local_file(CROSS_ENCODER, "/root/cross_encoder.py")
)

app = modal.App("odin-reranker")


@app.cls(image=image, gpu="L4", scaledown_window=180, max_containers=1, timeout=120)
class Reranker:
    @modal.enter()
    def load(self) -> None:
        from cross_encoder import CrossEncoder
        from huggingface_hub import snapshot_download

        base = snapshot_download(BASE, revision=BASE_REVISION)
        root = Path(snapshot_download(ADAPTERS, revision=ADAPTERS_REVISION))
        self.members = [CrossEncoder(adapter=root / m, base=base) for m in MEMBERS]

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def score(self, body: dict) -> dict:
        from fastapi import HTTPException

        query, texts = body.get("query"), body.get("texts")
        valid = (
            isinstance(query, str)
            and 0 < len(query) <= MAX_CHARS
            and isinstance(texts, list)
            and 2 <= len(texts) <= MAX_TEXTS
            and all(isinstance(t, str) and len(t) <= MAX_CHARS for t in texts)
        )
        if not valid:
            raise HTTPException(
                400, "expected a query and 2 to 50 texts of at most 8000 characters"
            )
        return {"scores": [m.score(query, texts).tolist() for m in self.members]}
