import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
MANIFEST = MODELS / "adapters.json"
CARD = MODELS / "hub" / "README.md"
LOCAL_FOLDER = {"v1": "ce_adapter_v1", "v2": "ce_adapter"}
ADAPTER_FILES = ("adapter_config.json", "adapter_model.safetensors", "training.json")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def local_files() -> dict[str, Path]:
    files = {
        f"{version}/{name}": MODELS / folder / name
        for version, folder in LOCAL_FOLDER.items()
        for name in ADAPTER_FILES
    }
    return files | {"reranker.json": MODELS / "reranker.json"}


def read_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def write_manifest(manifest: dict) -> None:
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8", newline="\n")


def differing(files: dict[str, Path], recorded: dict[str, dict]) -> list[str]:
    return [
        name
        for name, path in files.items()
        if not path.exists() or sha256(path) != recorded[name]["sha256"]
    ]


def record() -> int:
    if MANIFEST.exists():
        sys.exit(f"{MANIFEST} exists; a new adapter gets a new manifest entry by hand")
    files = local_files()
    absent = [str(p) for p in files.values() if not p.exists()]
    if absent:
        sys.exit(f"missing: {', '.join(absent)}")
    write_manifest(
        {
            "base_model": "Qwen/Qwen3-Reranker-0.6B",
            "repo": None,
            "revision": None,
            "files": {
                name: {"sha256": sha256(path), "bytes": path.stat().st_size}
                for name, path in files.items()
            },
        }
    )
    print(f"wrote {MANIFEST}")
    return 0


def verify() -> int:
    wrong = differing(local_files(), read_manifest()["files"])
    print("adapters match the recorded checksums" if not wrong else f"differ: {wrong}")
    return 1 if wrong else 0


def publish(repo: str, public: bool) -> int:
    from huggingface_hub import HfApi

    manifest = read_manifest()
    files = local_files()
    wrong = differing(files, manifest["files"])
    if wrong:
        sys.exit(f"local files differ from {MANIFEST}: {wrong}")
    api = HfApi()
    api.create_repo(repo, repo_type="model", private=not public, exist_ok=True)
    sums = "".join(f"{entry['sha256']}  {name}\n" for name, entry in manifest["files"].items())
    uploads = {name: path.read_bytes() for name, path in files.items()}
    uploads |= {"README.md": CARD.read_bytes(), "SHA256SUMS": sums.encode()}
    commit = None
    for name, content in uploads.items():
        commit = api.upload_file(
            path_or_fileobj=content,
            path_in_repo=name,
            repo_id=repo,
            repo_type="model",
            commit_message=f"Add {name}",
        )
    revision = api.model_info(repo).sha
    write_manifest(manifest | {"repo": repo, "revision": revision})
    print(f"published {len(uploads)} files to {repo} at {revision} ({commit.commit_url})")
    print(f"commit {MANIFEST} so the download step is pinned to this revision")
    return 0


def fetch() -> int:
    from huggingface_hub import hf_hub_download

    manifest = read_manifest()
    if not manifest["repo"]:
        sys.exit("the adapters are not published yet; train them with `make reranker`")
    files = local_files()
    for name in differing(files, manifest["files"]):
        got = Path(
            hf_hub_download(
                manifest["repo"], name, revision=manifest["revision"], repo_type="model"
            )
        )
        if sha256(got) != manifest["files"][name]["sha256"]:
            sys.exit(f"{name} from {manifest['repo']} does not match its recorded checksum")
        files[name].parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(got, files[name])
        print(f"fetched {name}")
    return verify()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["record", "verify", "publish", "fetch"])
    ap.add_argument("--repo")
    ap.add_argument("--public", action="store_true")
    args = ap.parse_args()
    if args.step == "publish":
        if not args.repo:
            sys.exit("publish needs --repo USER/NAME")
        return publish(args.repo, args.public)
    return {"record": record, "verify": verify, "fetch": fetch}[args.step]()


if __name__ == "__main__":
    sys.exit(main())
