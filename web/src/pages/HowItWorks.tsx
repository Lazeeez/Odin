import { Highlights, Lessons } from "../components/Engineering.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import type { Summary } from "../lib/data.ts";
import { href } from "../lib/router.ts";

const BROWSER_STEPS: [string, string][] = [
  ["Download", "The file list comes from GitHub's API (one request), the Python files from GitHub's file server, sixteen at a time. If GitHub's API is unavailable, the jsDelivr mirror stands in."],
  ["Parse", "Tree-sitter, compiled to WebAssembly, splits every file into functions, methods and classes, exactly like the Python engine does."],
  ["Index", "A code-aware BM25 index: snake_case and camelCase names are split into words and also kept whole, so both prose and exact names match."],
  ["Rank", "A learned ranker (LambdaMART, 491 trees shipped as JSON) weighs 33 signals: keyword scores for the issue, its title and its quoted code, whether a traceback or the issue names the function, file-level evidence and the shape of the code."],
  ["Refine", "A small language model (MiniLM) reads the top 20 candidates and the issue, and a second ranker blends that in. It runs on your GPU when WebGPU is available."],
  ["Remember", "Parsed repositories are cached by git tree hash and embeddings by content hash, so a second visit is instant. All of this happens in a background thread: the page never freezes."],
];

export function HowItWorks({ summary }: { summary: Summary | null }) {
  return (
    <div class="container">
      <header class="page-head">
        <p class="kicker">How it works</p>
        <h1>From bug report to the right function</h1>
        <p>
          Odin is a ranking cascade: cheap signals over every function first, then progressively more expensive models over fewer and
          fewer candidates. The full pipeline runs on a GPU; a lighter version runs entirely in your browser.
        </p>
      </header>

      <section class="card block">
        <h2>The full pipeline</h2>
        <p class="card-lede">Five stages, each measured on 300 real bugs. Pick a stage to see what it adds.</p>
        {summary ? <Pipeline summary={summary} /> : <p class="muted">Loading…</p>}
      </section>

      <section class="card block">
        <h2>What happens in your browser</h2>
        <p class="card-lede">When you <a href={href("search")}>search a repository</a>, nothing is sent to a server of ours. Your browser does all of this:</p>
        <ol class="flow">
          {BROWSER_STEPS.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
        </ol>
      </section>

      <section class="block">
        <h2>Engineering highlights</h2>
        <Highlights />
      </section>

      <section class="card block">
        <h2>What didn't work</h2>
        <p class="card-lede">Negative results, kept because they explain the design.</p>
        <Lessons />
      </section>
    </div>
  );
}
