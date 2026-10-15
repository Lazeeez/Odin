import { useRef } from "preact/hooks";
import { Bars } from "../components/Bars.tsx";
import { LiveSection, useLive } from "../components/Live.tsx";
import { PageHero } from "../components/PageHero.tsx";
import { Tile } from "../components/Tile.tsx";
import { RepoTable, SignificanceTable, StageChart } from "../components/Results.tsx";
import { type BrowserEval, type Lite, type Summary, stagesAt } from "../lib/data.ts";
import { pct } from "../lib/format.ts";
import { useReveal } from "../lib/reveal.ts";
import { href } from "../lib/router.ts";

function BrowserComparison({ e, full, depth }: { e: BrowserEval; full?: number; depth: number }) {
  const rows = [
    { label: "Keyword search only", value: e.keyword["hit@10"] },
    { label: "Instant ranking", value: e.instant["hit@10"], detail: "keyword and mention signals, milliseconds" },
    { label: "+ semantic index", value: e.semantic["hit@10"], detail: "every function embedded in the background", emphasis: !e.rerank },
    ...(e.rerank ? [{ label: `+ language-model rerank of the top ${depth}`, value: e.rerank["hit@10"], emphasis: true }] : []),
    ...(full != null ? [{ label: "Full pipeline (GPU server)", value: full, detail: "larger models, git history, LLM reranker" }] : []),
  ];
  return <Bars label="Function in the top 10, by in-browser stage" format={pct} rows={rows} />;
}

function FileComparison({ e }: { e: BrowserEval }) {
  const rows = [
    { label: "Files of the best functions", value: e.files_best_function["hit@5"] },
    { label: "File ranker", value: e.files["hit@5"], emphasis: true },
  ];
  return <Bars label="File in the top 5" format={pct} rows={rows} />;
}

/** Three terms the page uses, in plain words, before any chart. */
const GUIDE: [string, string][] = [
  ["Top 10", "hit@10: the share of issues with at least one gold function among the first 10 results; recall@10 counts every gold function."],
  ["Ranked first", "hit@1: the top-ranked unit is gold. MRR averages 1/rank of the first gold unit, so it rewards near misses too."],
  ["Significant", "Paired bootstrap over the same issues, 10,000 resamples: ✓ when p < 0.05 and the 95% interval of the change excludes zero."],
];

export function Benchmarks({ summary, lite, failed }: { summary: Summary | null; lite: Lite | null; failed: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  const fn = summary ? stagesAt(summary, "function").at(-1)! : null;
  const fl = summary ? stagesAt(summary, "file").at(-1)! : null;
  const live = useLive();
  return (
    <div class="container" ref={root}>
      <PageHero kicker="Benchmarks" title="How often Odin finds the fix">
        <p>
          Measured on SWE-bench Lite: 300 real GitHub issues from 12 Python projects. Each is searched at the commit where the bug was
          reported, and a result counts only if the maintainers' actual fix changed it. None of these issues was used for training or
          tuning.
        </p>
      </PageHero>
      {failed && <p class="error-text">Couldn't load the benchmark data. Try reloading the page.</p>}
      {!failed && (
        <div class="tiles reveal">
          <Tile label="Function to fix in the top 10" value={fn ? fn["hit@10"] : null} note={fn ? `${fn.n} issues, 10k–45k functions per project` : "SWE-bench Lite"} />
          <Tile label="Function to fix ranked first" value={fn ? fn["hit@1"] : null} note={fn ? `${fn.n} issues: 300 minus ${300 - fn.n} with no function to find` : "SWE-bench Lite"} />
          <Tile label="File to fix in the top 5" value={fl ? fl["hit@5"] : null} note={fl ? `file level, all ${fl.n} issues` : "SWE-bench Lite"} />
        </div>
      )}

      <dl class="guide reveal">
        {GUIDE.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
      </dl>

      {summary && (
        <>
          <section class="card frame block reveal">
            <p class="kicker">Stage by stage</p>
            <h2>Each stage finds more</h2>
            <p class="card-lede">hit@k, recall@10 and MRR per stage over 291 issues, at function or file level. Whiskers are 95% bootstrap intervals; hover for sample size and median latency.</p>
            <StageChart summary={summary} />
          </section>

          <section class="card frame block reveal">
            <p class="kicker">No lucky gains</p>
            <h2>Is each step a real improvement?</h2>
            <p class="card-lede">Every step is tested against the one before it on the same bugs, so a gain from luck shows up as not significant.</p>
            <SignificanceTable summary={summary} />
          </section>

          <section class="card frame block reveal">
            <p class="kicker">By project</p>
            <h2>Where it's easy, and where it's hard</h2>
            <p class="card-lede">Share of fix locations in the top 10, per project. Projects whose bug reports rarely name the code, like SymPy and pytest, gain the most from the smarter stages.</p>
            <RepoTable summary={summary} />
          </section>
        </>
      )}

      {lite && (
        <section class="card frame block reveal">
          <p class="kicker">In your browser</p>
          <h2>On projects it has never seen</h2>
          <p class="card-lede">
            The <a href={href("search")}>search page</a> runs a lighter pipeline on your device. Its rankers were trained on 131 other
            projects; these {lite.held_out.unseen.keyword.n} bugs come from 30 projects that were kept out of training entirely, the
            situation the search page is in every time you paste a new repository.
          </p>
          <BrowserComparison e={lite.held_out.unseen} depth={lite.depth} />
          <p class="note">Share of bugs with a function the real fix changed in the top 10.</p>
          <h3 class="subhead">Finding the file</h3>
          <FileComparison e={lite.held_out.unseen} />
          <p class="note">Share of bugs with a file the real fix changed in the top 5.</p>
        </section>
      )}

      {lite && fn && (
        <section class="card frame block reveal">
          <p class="kicker">In your browser</p>
          <h2>On SWE-bench Lite</h2>
          <p class="card-lede">The same pipeline on the {lite.held_out.lite.keyword.n} Lite issues above, next to the full GPU pipeline.</p>
          <BrowserComparison e={lite.held_out.lite} depth={lite.depth} full={fn["hit@10"]} />
          <p class="note">Share of issues with a function the real fix changed in the top 10.</p>
        </section>
      )}

      {live && <LiveSection live={live} />}

      <section class="card frame block reveal">
        <p class="kicker">Method</p>
        <h2>How the numbers are kept honest</h2>
        <ul class="plain-list">
          <li>Every issue is searched at its own base commit. Indexing today's code would leak the fix.</li>
          <li>Nothing is tuned on these 300 issues: fusion weights on a separate dev set, learned rankers on 1,941 other SWE-bench issues, reranker weights on a held-out split.</li>
          <li>Git-history features only see commits before the bug; "similar past bugs" only see issues opened at least 30 days earlier. Both boundaries have tests.</li>
          <li>Every improvement comes with a paired bootstrap test, and ones that aren't significant are reported as such.</li>
          <li>Lite is not untouched. Every evaluation on it is logged with what was decided from it (results/test-evals.log in the repository), and one decision, rejecting a distilled reranker, was taken on a Lite result, in the conservative direction.</li>
        </ul>
      </section>
    </div>
  );
}
