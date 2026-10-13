---
license: apache-2.0
base_model: Qwen/Qwen3-Reranker-0.6B
library_name: peft
pipeline_tag: text-ranking
language:
- en
tags:
- lora
- reranker
- code-search
- bug-localization
- swe-bench
---

# Odin reranker adapters

Two LoRA adapters for [Qwen/Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B), fine-tuned to answer one question: given a bug report and a Python function, is this a function the fix will change?

They are the last stage of [Odin](https://github.com/Lazeeez/Odin), a bug-localization pipeline: keyword and embedding retrieval, a LambdaMART ranker, then these adapters over the ranker's top 20 candidates. They are meant to be used as that last stage. Used alone to rank candidates they did worse than the LambdaMART ranker on the validation split.

## Files

| Path | What it is |
|---|---|
| `v1/` | Adapter trained for 1 epoch on hard negatives taken from the hybrid retriever's top 30 |
| `v2/` | Adapter trained for 2 epochs on hard negatives taken from out-of-fold LambdaMART rankings, the candidates the reranker sees at query time |
| `reranker.json` | The ensemble: both adapters, depth 20, blend weights 2.0 (function level) and 0.5 (file level), chosen on the validation split |
| `SHA256SUMS` | Checksums of every file above |

The two adapters are used together. Each scores a candidate as logit("yes") minus logit("no") at the final position, the scores are z-scored per query, and the ensemble is their mean.

## Training

- **Data.** 1,691 issues from SWE-bench test: all of it minus the 300 SWE-bench Lite issues, minus a 250-issue validation split. No Lite issue was used for training or for choosing any setting.
- **Objective.** Listwise: one function the fix changed and its 3 hardest wrong candidates for the same issue, trained with softmax cross-entropy to put the right one first.
- **LoRA.** Rank 16, alpha 32, dropout 0.05, on every attention and MLP projection. Learning rate 1e-4. Issues are truncated to 512 tokens and functions to 256.
- **Hardware.** One RTX 4050 laptop GPU (6 GB); about 32 minutes per epoch.

## Results

SWE-bench Lite, function level, 291 issues (the 300 minus 9 whose fix changes module-level code only). The reranker reorders the LambdaMART ranker's top 20.

| | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| LambdaMART ranker | 0.344 | 0.643 | 0.729 | 0.497 |
| + these adapters (ensemble) | 0.407 | 0.706 | 0.772 | 0.560 |

Paired bootstrap, 10,000 resamples: recall@1 +0.063 (p = 0.006), recall@10 +0.043 (p = 0.005), MRR +0.063 (p < 0.001).

Lite is a test set that has been scored many times over the project's life; the repository's `results/test-evals.log` lists every evaluation. The per-issue rankings behind this table are in the repository under `results/`.

## Use

```sh
git clone https://github.com/Lazeeez/Odin && cd Odin
uv sync --extra dense
make adapters          # downloads these files into models/ and verifies their checksums
make eval RETRIEVER=ltr-ce-notests LEVEL=function
```

With PEFT directly:

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = "Qwen/Qwen3-Reranker-0.6B"
tokenizer = AutoTokenizer.from_pretrained(base)
model = PeftModel.from_pretrained(
    AutoModelForCausalLM.from_pretrained(base), "lazeeez/odin-reranker-adapters", subfolder="v2"
)
```

The prompt format is the one in the repository's `src/odin/rank/cross_encoder.py`; scores are only meaningful with it.

## Limits

- Python only, and trained on twelve projects (the SWE-bench ones). How it does on other projects has not been measured for this stage.
- The issues and their fixes are public and predate the base model, so the base model may have seen them. The repository's sealed holdout exists to measure this.
- The table above depends on the whole pipeline, including an embedding model released under a non-commercial licence (`jinaai/jina-code-embeddings-0.5b`, CC-BY-NC-4.0). These adapters do not contain it.
- Latency on the laptop GPU above: about 3.3 s per query (p50) at function level for the ensemble.

## Licence

Apache-2.0, the licence of the base model. The training issues and patches come from SWE-bench, whose dataset card declares no licence; they originate in twelve open-source projects.
