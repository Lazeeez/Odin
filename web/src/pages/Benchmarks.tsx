import { Bars } from "../components/Bars.tsx";
import { RepoTable, SignificanceTable, StageChart } from "../components/Results.tsx";
import { type Lite, type Summary, stagesAt } from "../lib/data.ts";
import { pct } from "../lib/format.ts";
import { href } from "../lib/router.ts";

function BrowserComparison({ lite, full }: { lite: Lite; full: number }) {
  const { keyword, stage1, stage2 } = lite.lite;
  const rows = [
    { label: "Keyword search only", value: keyword["hit@10"] },
    { label: "Instant learned ranking", value: stage1["hit@10"], detail: "no model download" },
    ...(stage2 ? [{ label: `+ semantic rerank of the top ${lite.depth}`, value: stage2["hit@10"], emphasis: true }] : []),
    { label: "Full pipeline (GPU server)", value: full, detail: "larger models, git history, LLM reranker" },
  ];
  return <Bars label="Function in the top 10: in-browser stages against the full pipeline" format={pct} rows={rows} />;
}

export function Benchmarks({ summary, lite, failed }: { summary: Summary | null; lite: Lite | null; failed: boolean }) {
  const fn = summary ? stagesAt(summary, "function").at(-1)! : null;
  const fl = summary ? stagesAt(summary, "file").at(-1)! : null;
  return (
    <div class="container">
      <header class="page-head">
        <p class="kicker">Benchmarks</p>
        <h1>How often Odin finds the fix</h1>
        <p>
          Measured on SWE-bench Lite: 300 real GitHub issues from 12 Python projects. Each is searched at the commit where the bug was
          reported, and a result counts only if the maintainers' actual fix changed it. None of these issues was used for training or
          tuning.
        </p>
      </header>
      {failed && <p class="error-text">Couldn't load the benchmark data. Try reloading the page.</p>}
      {fn && fl && (
        <div class="tiles">
          <div class="tile"><span class="tile-label">Function to fix in the top 10</span><span class="tile-value">{pct(fn["hit@10"])}</span><span class="tile-note">out of 10k–45k per project</span></div>
          <div class="tile"><span class="tile-label">Function to fix ranked first</span><span class="tile-value">{pct(fn["hit@1"])}</span><span class="tile-note">top result is right</span></div>
          <div class="tile"><span class="tile-label">File to fix in the top 5</span><span class="tile-value">{pct(fl["hit@5"])}</span><span class="tile-note">file level</span></div>
        </div>
      )}

      {summary && (
        <>
          <section class="card block">
            <h2>Stage by stage</h2>
            <p class="card-lede">Each stage of the pipeline, from plain keyword search to the fine-tuned LLM reranker. Hover a bar for details.</p>
            <StageChart summary={summary} />
          </section>

          <section class="card block">
            <h2>Is each step a real improvement?</h2>
            <p class="card-lede">Every step is tested against the one before it on the same issues, so a gain from luck shows up as not significant.</p>
            <SignificanceTable summary={summary} />
          </section>

          <section class="card block">
            <h2>By project</h2>
            <p class="card-lede">Recall@10 at function level, per repository. Projects whose issues rarely name the code, like SymPy and pytest, gain the most from the semantic and learned stages.</p>
            <RepoTable summary={summary} />
          </section>
        </>
      )}

      {lite && fn && (
        <section class="card block">
          <h2>In your browser</h2>
          <p class="card-lede">
            The <a href={href("search")}>search page</a> runs a lighter pipeline entirely on your device, measured on the same {lite.lite.keyword.n} issues.
          </p>
          <BrowserComparison lite={lite} full={fn["hit@10"]} />
          <p class="note">Share of issues with a function the real fix changed in the top 10.</p>
        </section>
      )}

      <section class="card block">
        <h2>How the numbers are kept honest</h2>
        <ul class="plain-list">
          <li>Every issue is searched at its own base commit. Indexing today's code would leak the fix.</li>
          <li>Nothing is tuned on these 300 issues: fusion weights on a separate dev set, learned rankers on 1,941 other SWE-bench issues, reranker weights on a held-out split.</li>
          <li>Git-history features only see commits before the bug; "similar past bugs" only see issues opened at least 30 days earlier. Both boundaries have tests.</li>
          <li>Every improvement comes with a paired bootstrap test, and ones that aren't significant are reported as such.</li>
        </ul>
      </section>
    </div>
  );
}
