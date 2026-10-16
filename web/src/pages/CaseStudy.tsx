import { useRef } from "preact/hooks";
import { useLive } from "../components/Live.tsx";
import { PageHero } from "../components/PageHero.tsx";
import { Tile } from "../components/Tile.tsx";
import { bestBrowserStage, type Lite, type Summary, stagesAt } from "../lib/data.ts";
import { LIVE_MIN_BUGS } from "../lib/feedback.ts";
import { REPO_URL } from "../lib/links.ts";
import { useReveal } from "../lib/reveal.ts";
import { href } from "../lib/router.ts";

const adr = (n: string) => `${REPO_URL}/blob/main/docs/decisions/${n}`;

const DECISIONS: [string, string, string][] = [
  ["Measure first, build second",
    "The evaluation harness came before the search engine: every issue is searched at the commit it was filed against, and the answer key is the functions the real fix changed. Every claimed improvement has a paired bootstrap test.",
    "0001-eval-first.md"],
  ["A cascade: cheap over everything, expensive over little",
    "Code-aware keyword search over every function, then learned ranking over a few hundred, then a fine-tuned language model over the top 20 to 50. Each stage is kept only if it measurably beats the one before.",
    "0007-fine-tuned-cross-encoder.md"],
  ["The same engine, twice",
    "The website runs a TypeScript port of the Python engine in Web Workers. Parity tests run both on the same code and require identical units, keyword scores and ranker inputs, so the browser inherits the measured accuracy.",
    "0009-in-browser-search.md"],
  ["A GPU only where it pays",
    "The full pipeline's reranker runs on a GPU server for the website only after a test, fixed in advance, showed +2.6 points; a second test showed the browser's own language model could then be skipped, saving 50 MB and about 15 s. Scored once on held-out data, it adds 6.5 points on SWE-bench Lite and 2.7 on unseen projects.",
    "0021-website-server-reranker.md"],
  ["Six languages, each earning its ranker",
    "JavaScript, TypeScript, Go, Java and Rust were added with a rule written before training: the learned ranker is used for a language only if it beats keywords and meaning by 2 points in cross-validation. All six passed, by 12 to 24.",
    "0025-more-languages.md"],
];

const FAILED: [string, string][] = [
  ["Following the call graph", "Expanding results to callers and callees added candidates but not hits; it is off by default."],
  ["One distilled reranker instead of two", "Better on validation, worse on the test set's first place: rejected, and the README says it was a test-set decision."],
  ["A learned query projection for the embeddings", "Semantic-only MRR fell from 0.287 to 0.220 on held-out projects."],
  ["A small language model in the browser", "Added nothing on projects it never saw; the GPU reranker replaced it."],
];

const SAFEGUARDS = [
  "Nothing is trained or tuned on a test set; every test-set evaluation is logged with what was decided from it.",
  "A sealed holdout of recent issues from 189 projects is reserved for one final run.",
  "Every number in the README is checked against its result file, and every result file records the code and data that produced it.",
  "A decision record for every choice, negative results included, each written before its test.",
  "Unit, browser (Chromium, Firefox, WebKit) and Python/TypeScript parity tests run in CI.",
];

export function CaseStudy({ summary, lite }: { summary: Summary | null; lite: Lite | null }) {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  const live = useLive();
  const fn = summary ? stagesAt(summary, "function").at(-1)! : null;
  const unseen = lite ? bestBrowserStage(lite.held_out.unseen)["hit@10"] : null;
  const multi = lite?.held_out.multilingual;
  const gpu = lite?.gpu_reranker;
  const liveWindow = live?.last_30_days;
  return (
    <div class="container case-study" ref={root}>
      <PageHero kicker="Case study" title="Finding the code behind a bug report">
        <p>
          Given a bug report and a repository, Odin ranks the functions most likely to need the fix. It is a research pipeline measured on
          real bug fixes, a website that runs it in your browser on public code in six languages, and a GitHub Action that comments on new issues.
        </p>
      </PageHero>

      <section class="block reveal">
        <p class="kicker">The problem</p>
        <h2>Most of fixing a bug is finding it.</h2>
        <p class="section-lede">
          A report says what went wrong, not where. In a large repository the answer is one of tens of thousands of functions, and the report
          may name it, quote a stack trace through it, or only describe a symptom. Odin is scored the way a developer would judge it: is a
          function the maintainers' real fix changed among the first ten it suggests?
        </p>
      </section>

      <section class="block reveal">
        <p class="kicker">Results</p>
        <h2>On bugs it never trained on.</h2>
        <div class="tiles four">
          <Tile label="Full pipeline, SWE-bench Lite" value={fn ? fn["hit@10"] : null} note={fn ? `function in the top 10, ${fn.n} issues` : ""} />
          {gpu?.held_out?.unseen ? (
            <Tile label="The website, 30 unseen projects" value={gpu.held_out.unseen.with_reranker["hit@10"]}
              note={`${gpu.held_out.unseen.issues} bugs, Python, with the GPU reranker; ${Math.round(gpu.held_out.unseen.website["hit@10"] * 1000) / 10}% without`} />
          ) : (
            <Tile label="In the browser, 30 unseen projects" value={unseen} note={lite ? `${lite.held_out.unseen.keyword.n} bugs, Python` : ""} />
          )}
          <Tile label="In the browser, five more languages" value={multi ? bestBrowserStage(multi)["hit@10"] : null} note={multi ? `${multi.keyword.n} bugs, SWE-bench Multilingual` : ""} />
          {liveWindow && liveWindow.bugs >= LIVE_MIN_BUGS && liveWindow.function ? (
            <Tile label="Live, bugs fixed this month" value={liveWindow.function["hit@10"]} note={`${liveWindow.bugs} bugs from ${liveWindow.projects} projects`} />
          ) : (
            <Tile label="With the GPU reranker, unseen projects" value={gpu?.held_out?.unseen ? gpu.held_out.unseen.with_reranker["hit@10"] : gpu ? gpu.with_reranker["hit@10"] : null}
              note={gpu?.held_out?.unseen ? `vs ${Math.round(gpu.held_out.unseen.website["hit@10"] * 1000) / 10}% without, ${gpu.held_out.unseen.issues} bugs, held out` : ""} />
          )}
        </div>
        <p class="note">
          Share of bugs with a function the real fix changed in Odin's top 10. Full methodology, intervals and every stage on <a href={href("benchmarks")}>Benchmarks</a>.
        </p>
      </section>

      <section class="block reveal">
        <p class="kicker">Decisions</p>
        <h2>What mattered most.</h2>
        <ol class="case-list">
          {DECISIONS.map(([title, text, file]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text} <a href={adr(file)} target="_blank" rel="noopener">Decision record ↗</a></p>
            </li>
          ))}
        </ol>
      </section>

      <section class="block reveal">
        <p class="kicker">Negative results</p>
        <h2>What didn't work.</h2>
        <ul class="case-list">
          {FAILED.map(([title, text]) => <li key={title}><h3>{title}</h3><p>{text}</p></li>)}
        </ul>
        <p class="note">Every experiment, kept or not, is on <a href={href("how")}>How it works</a> and in the decision records.</p>
      </section>

      <section class="block reveal">
        <p class="kicker">Rigor</p>
        <h2>Why the numbers can be trusted.</h2>
        <ul class="case-list plain">
          {SAFEGUARDS.map((s) => <li key={s}>{s}</li>)}
        </ul>
      </section>

      <section class="block reveal">
        <p class="kicker">Go deeper</p>
        <div class="case-links">
          <a class="btn primary sheen" href={href("search")}>Try it on a repository</a>
          <a class="btn" href={REPO_URL} target="_blank" rel="noopener">Source on GitHub ↗</a>
          <a class="btn" href={`${REPO_URL}/tree/main/docs/decisions`} target="_blank" rel="noopener">All decision records ↗</a>
          <a class="btn" href={href("explore")}>Watch it on real bugs</a>
        </div>
      </section>
    </div>
  );
}
