import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.rank.cross_encoder import CrossEncoder  # noqa: E402


def scorer(ce: CrossEncoder):
    import torch

    head = ce.model.lm_head.weight
    direction = (head[ce.yes] - head[ce.no]).detach().float().clone()

    class Scorer(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.body = ce.model.model
            self.register_buffer("direction", direction)

        def forward(self, input_ids, attention_mask):
            positions = (attention_mask.cumsum(-1) - 1).clamp(min=0)
            hidden = self.body(
                input_ids=input_ids, attention_mask=attention_mask, position_ids=positions
            ).last_hidden_state[:, -1]
            return hidden.float() @ self.direction

    return Scorer().eval()


def samples(ce: CrossEncoder, n: int = 6) -> list[list[int]]:
    tasks = ROOT / "results" / "odin-max" / "work" / "eval_tasks.jsonl"
    out = []
    with tasks.open(encoding="utf-8") as handle:
        task = json.loads(handle.readline())
    prefix = ce.prefix_ids(task["query"])
    for text in task["texts"][:n]:
        out.append(prefix + ce.doc_ids(text))
    return out


def left_pad(seqs: list[list[int]]) -> tuple[np.ndarray, np.ndarray]:
    width = max(len(s) for s in seqs)
    ids = np.zeros((len(seqs), width), np.int64)
    mask = np.zeros((len(seqs), width), np.int64)
    for i, s in enumerate(seqs):
        ids[i, width - len(s) :] = s
        mask[i, width - len(s) :] = 1
    return ids, mask


def export(adapter: Path, out: Path) -> None:
    import torch

    ce = CrossEncoder(adapter=adapter, device="cpu")
    ce.model.config._attn_implementation = "eager"
    model = scorer(ce)
    seqs = samples(ce)
    ids, mask = left_pad(seqs)
    with torch.no_grad():
        got = model(torch.from_numpy(ids), torch.from_numpy(mask)).numpy()
        single = np.array(
            [float(model(torch.tensor([s]), torch.ones(1, len(s), dtype=torch.long))) for s in seqs]
        )
    print("padded batch vs one at a time, max diff:", float(np.abs(got - single).max()))
    out.mkdir(parents=True, exist_ok=True)
    fp32 = out / "fp32" / "model.onnx"
    fp32.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    torch.onnx.export(
        model,
        (torch.from_numpy(ids), torch.from_numpy(mask)),
        str(fp32),
        input_names=["input_ids", "attention_mask"],
        output_names=["score"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"}, "score": {0: "batch"}},
        opset_version=17,
        dynamo=False,
        external_data=True,
    )  # fmt: skip
    print(f"exported {fp32} in {time.time() - t0:.0f}s")
    np.save(out / "check_ids.npy", ids)
    np.save(out / "check_mask.npy", mask)
    np.save(out / "check_scores.npy", single.astype(np.float32))
    ce.tok.save_pretrained(str(out))


def quantize(out: Path, name: str, block: int, symmetric: bool, bits: int, layers: bool) -> None:
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    model = onnx.load(str(out / "fp32" / "model.onnx"))
    if layers:
        q = MatMulNBitsQuantizer(model, block_size=block, is_symmetric=symmetric, bits=bits)
        q.process()
        model = q.model.model
    target = out / name
    onnx.save_model(model, str(target), save_as_external_data=not layers)
    print(f"wrote {target} ({target.stat().st_size / 1e6:.0f} MB)")


def embed_int8(out: Path, name: str, external: bool) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    path = out / name
    model = onnx.load(str(path))
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    gathers = [n for n in graph.node if n.op_type == "Gather" and n.input[0] in inits]
    table_name = max((n.input[0] for n in gathers), key=lambda name: int(np.prod(inits[name].dims)))
    table = numpy_helper.to_array(inits[table_name]).astype(np.float32)
    scale = np.abs(table).max(axis=1, keepdims=True) / 127.0
    scale[scale == 0] = 1.0
    q = np.clip(np.round(table / scale), -127, 127).astype(np.int8)
    graph.initializer.remove(inits[table_name])
    graph.initializer.extend(
        [
            numpy_helper.from_array(q, table_name + "_int8"),
            numpy_helper.from_array(scale.astype(np.float32), table_name + "_scale"),
        ]
    )
    for node in [n for n in gathers if n.input[0] == table_name]:
        at = list(graph.node).index(node)
        rows, scales, cast = (node.output[0] + s for s in ("_rows", "_scales", "_cast"))
        new = [
            helper.make_node("Gather", [table_name + "_int8", node.input[1]], [rows], axis=0),
            helper.make_node("Gather", [table_name + "_scale", node.input[1]], [scales], axis=0),
            helper.make_node("Cast", [rows], [cast], to=TensorProto.FLOAT),
            helper.make_node("Mul", [cast, scales], [node.output[0]]),
        ]
        graph.node.remove(node)
        for k, n in enumerate(new):
            graph.node.insert(at + k, n)
    onnx.save_model(model, str(path), save_as_external_data=external)
    print(f"embedding table {table.shape} as int8; {path} is {path.stat().st_size / 1e6:.0f} MB")


def check(out: Path, name: str) -> None:
    import onnxruntime as ort

    session = ort.InferenceSession(str(out / name), providers=["CPUExecutionProvider"])
    ids, mask = np.load(out / "check_ids.npy"), np.load(out / "check_mask.npy")
    want = np.load(out / "check_scores.npy")
    t0 = time.time()
    got = session.run(["score"], {"input_ids": ids, "attention_mask": mask})[0]
    print(f"{name}: {time.time() - t0:.1f}s on CPU for {ids.shape}")
    print("  pytorch:", np.round(want, 3).tolist())
    print("  onnx:   ", np.round(got, 3).tolist())
    print(
        "  max diff",
        float(np.abs(got - want).max()),
        " rank corr",
        float(np.corrcoef(np.argsort(np.argsort(got)), np.argsort(np.argsort(want)))[0, 1]),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["export", "quantize", "check"])
    ap.add_argument("--adapter", type=Path, default=ROOT / "models" / "ce_adapter")
    ap.add_argument("--out", type=Path, default=ROOT / "results" / "browser-reranker" / "work")
    ap.add_argument("--block", type=int, default=32)
    ap.add_argument("--name", default="model_q4.onnx")
    ap.add_argument("--bits", type=int, default=4)
    ap.add_argument("--asymmetric", action="store_true")
    ap.add_argument("--float-layers", action="store_true")
    ap.add_argument("--float-embedding", action="store_true")
    args = ap.parse_args()
    if args.step == "export":
        export(args.adapter, args.out)
    elif args.step == "quantize":
        quantize(
            args.out, args.name, args.block, not args.asymmetric, args.bits, not args.float_layers
        )
        if not args.float_embedding:
            embed_int8(args.out, args.name, args.float_layers)
    else:
        check(args.out, args.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
