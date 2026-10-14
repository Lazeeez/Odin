# Running Odin jobs on PACE

Every heavy experiment is a **manifest** in `cluster/manifests/`. A job ranks the issues a manifest names into a run directory. It never sees ground truth: scoring happens when the run is imported back into the repository.

**Being brought up on PACE (ICE), 2026-10-14.** `preflight.sh` and `setup.sh` pass there. The first job failed because it resolved packages offline; `fetch.sh` now builds the job's environment in advance. No job has completed on the cluster yet.

## Once per cluster account

```sh
git clone <repository> ~/odin && cd ~/odin
cp cluster/site.env.example cluster/site.env     # then fill in the values
bash cluster/preflight.sh                        # checks the account, partition and paths
bash cluster/setup.sh                            # uv and the locked environment, on the login node
```

`site.env` holds the Slurm account, partition and (where the cluster requires one) QOS, the GPU type, and two directories: one on project storage for results, one on scratch for caches. It is git-ignored.

## For each experiment

```sh
git pull                                         # the commit you run is recorded in the run
bash cluster/fetch.sh  cluster/manifests/NAME.json     # login node: models, dataset, git mirrors
bash cluster/submit.sh cluster/manifests/NAME.json     # prints the job id and the run directory
```

- Compute nodes have no internet, so `fetch.sh` must finish before `submit.sh`.
- The working tree must be clean. A run from uncommitted code is refused at import.
- A job that is killed or times out is resubmitted with the same command. Finished issues are skipped; at most the issue in progress is lost.
- When the job ends, the run directory is copied from scratch to `$ODIN_RESULTS/NAME/`.

## Bringing a run back

```sh
rsync -a pace:PATH_TO_ODIN_RESULTS/NAME/ runs/NAME/     # on the laptop
uv run odin import-run runs/NAME
```

`import-run` refuses the run unless every file matches its checksum, the manifest is the committed one, the commit is in this repository, the tree was clean, and every issue of the manifest is present. It then scores the rankings, writes `results/runs/NAME/result.json`, and appends a line to `results/test-evals.log` when the manifest names a test set.

## Testing a job before handing it over

```sh
uv run --extra dense odin run --manifest cluster/manifests/NAME.json --out /tmp/NAME --local 3
```

`--local N` runs the same code on the first N issues. A local run is marked as such and cannot be imported.

## Manifests

| Manifest | What it runs | Needs | Expected |
|---|---|---|---|
| `swerank-embed-small-lite` | SweRankEmbed-Small (137M) as the retriever over Odin's index, on Lite | one GPU, 6 GB; the `transformers<5` overlay in the manifest | about 30 GPU-minutes; fits the laptop |

A manifest's `environment.with` lists packages that replace the locked ones for that job. `fetch.sh` builds a separate environment for such a manifest under `$ODIN_SCRATCH/envs/NAME` on the login node, and the job runs from it: compute nodes have no internet, so nothing is resolved or installed at job time. A manifest without `environment.with` runs from the repository's own `.venv`.

## What is not here yet

- Apptainer definitions for the SWE-bench evaluation images (phase 7).
- vLLM serving for the larger rerankers and agents (phases 11 and 6).
