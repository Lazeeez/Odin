# Data sources and licences

Odin's own code is MIT (see [LICENSE](../LICENSE)). This file covers the data it is evaluated and trained on, and what of that data is in this repository. Licences were read from each source on 2026-10-13.

## Sources

| Source | Used for | Licence, as declared at the source |
|---|---|---|
| [SWE-bench](https://huggingface.co/datasets/princeton-nlp/SWE-bench), [SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite), [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified) | Lite: evaluation. Verified minus Lite: dev tuning. Full minus Lite: training the rankers and the reranker. | The dataset cards declare no licence. The SWE-bench code repository is MIT. The issues and patches in the datasets come from twelve open-source projects and stay under those projects' own licences. |
| [SWE-rebench](https://huggingface.co/datasets/nebius/SWE-rebench) | Training the website's rankers (120 projects) and the unseen-project test set (30 projects). | CC-BY-4.0, declared on the dataset card. Attribution: Nebius, SWE-rebench. |
| [SWE-rebench leaderboard](https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard) | The sealed holdout: 324 issues created on or after 2025-09-01, from 189 projects used nowhere else ([ADR 0013](../docs/decisions/0013-sealed-holdout.md)). | CC-BY-4.0, declared on the dataset card. Attribution: Nebius, SWE-rebench. |

## What this repository contains

| Path | Content | Derived from |
|---|---|---|
| `data/gold/swebench_*.jsonl` | Per issue: instance id, repository, base commit, and the files, functions and classes the fix changed. No issue text and no patch. | SWE-bench: the instance ids and base commits are copied; the locations are computed here by parsing each gold patch against the repository at its base commit. |
| `data/gold/swebench_rebench_*.jsonl`, `data/rebench_sample.json` | The same fields for the sampled SWE-rebench issues, and the list of sampled projects and instance ids. | SWE-rebench (CC-BY-4.0). |
| `data/holdout/manifest.json`, `data/gold/odin_holdout.jsonl` | The holdout's instance ids, repositories, base commits and creation dates, and the locations each fix changed. No issue text and no patch. | SWE-rebench leaderboard (CC-BY-4.0). |
| `results/*_lite_test.json` | Per issue: instance id, gold locations and ranked locations (paths and qualified names). No issue text. | SWE-bench Lite and each project's file and function names. |
| `web/public/data/issues/*.json`, `web/src/assets/showcase.json` | The text of the 300 SWE-bench Lite issues, with their gold locations and each stage's top 10, shown on the website's Explore page. | SWE-bench Lite. The issue text was written by users of the twelve projects on GitHub. |

The datasets themselves are not redistributed: `odin gold` downloads them from Hugging Face. The issue texts on the Explore page are the one place where dataset content is republished verbatim; they are public GitHub issues, reproduced with a link back to each one's fix.

## Models

Models are downloaded at run time and are not in this repository, apart from Odin's own trained rankers (`models/*.txt`, `web/src/assets/ranker.json`) and the quantized static embedding table the website ships.

| Model | Where it is used | Licence on its model card |
|---|---|---|
| `jinaai/jina-code-embeddings-0.5b` | dense retrieval in the GPU pipeline | CC-BY-NC-4.0: non-commercial |
| `Qwen/Qwen3-Reranker-0.6B` | base of the fine-tuned reranker | Apache-2.0 |
| `minishlab/potion-code-16M` | the website's semantic index; an int8 copy is committed as `web/src/assets/static-model.bin` | MIT |
| `Xenova/all-MiniLM-L6-v2` | the website's rerank of the top 20, downloaded by the visitor's browser | Apache-2.0 |

The non-commercial licence of the dense embedding model covers the GPU pipeline's hybrid, learned-ranking and reranking rows, which all use its scores. The website and anything else that runs for other people uses only the MIT and Apache-2.0 models.
