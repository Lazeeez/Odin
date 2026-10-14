# Running Odin jobs on PACE

Every heavy experiment is a **manifest** in `cluster/manifests/`. A job ranks the issues a manifest names into a run directory. It never sees ground truth: scoring happens when the run is imported back into the repository.

**Working on PACE (ICE) since 2026-10-14.** The first job, `swerank-embed-small-lite` on one L40S, reproduced the laptop's run of the same manifest: identical recall, hit, all@k and MRR on all 291 issues, the same top 10 for 290 of them, and 99.65% of top-100 items in common (`results/runs/swerank-embed-small-lite-pace/`).

What it took to get there, each fixed in the scripts:

- jobs resolved Python packages offline and failed; `fetch.sh` now builds each job's environment in advance;
- a model's older `transformers` conflicted with the project's pins; a manifest can now replace and drop packages;
- the login node killed a fetch that downloaded too much at once; it now downloads less and one project at a time;
- forced offline mode broke one model's own loading code; offline mode is now a site setting, off on ICE, whose compute nodes reach the internet;
- the shared scratch filesystem made jobs crawl; jobs now work from the node's local disk;
- parsing workers forked after PyTorch started deadlocked on Linux; they are now started with spawn.

Two submissions were killed before the third finished. Their 143 rankings carry no invocation record, because records were written only at the end; a run now records each invocation when it starts and stamps every ranking with the commit and Slurm job that produced it.

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

- `fetch.sh` must finish before `submit.sh`. Whether compute nodes can reach the internet differs by cluster; set `ODIN_OFFLINE=1` in `site.env` to force Hugging Face's offline mode in jobs. Some models' own loading code does not work in offline mode (SweRankEmbed-Small is one), so leave it at 0 where nodes have internet.
- The working tree must be clean. A run from uncommitted code is refused at import.
- A job that is killed or times out is resubmitted with the same command. Finished issues are skipped; at most the issue in progress is lost.
- A job copies the repository and the shared cache (git mirrors, embeddings, analysis cache) to the node's local disk before it starts, works there, and copies the cache back when it ends. On ICE the shared scratch is a network filesystem and the nodes have an 11 TB local disk at `/tmp`; set `ODIN_LOCAL_DISK=0` to work on scratch directly.
- Raise a job's time limit with `WALL_HOURS=6 bash cluster/submit.sh ...`.
- When the job ends, the run directory is copied from scratch to `$ODIN_RESULTS/NAME/`.

## Running a script instead of a manifest

Benchmarks and other scripts that are not manifest runs go through `submit_script.sh`, which uses the same local-disk staging:

```sh
WALL_HOURS=4 bash cluster/submit_script.sh "python benchmarks/bench_cascade.py --label pace-l40s"
```

The command runs from a copy of the repository on the node's local disk, with the repository's `.venv` on the path. Whatever it writes under `results/` or `models/` is copied to `$ODIN_RESULTS/script-<jobid>/` when it ends; the log is `$ODIN_SCRATCH/logs/script-<jobid>.log`.

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
