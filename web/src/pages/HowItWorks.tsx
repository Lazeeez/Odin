import { useRef } from "preact/hooks";
import { Highlights, Lessons, Worked } from "../components/Engineering.tsx";
import { ICONS, Icon } from "../components/Myth.tsx";
import { PageHero } from "../components/PageHero.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import type { Summary } from "../lib/data.ts";
import { useReveal } from "../lib/reveal.ts";
import { href } from "../lib/router.ts";

/** The browser's journey, each step in plain words first, then the detail for engineers. */
const JOURNEY: [keyof typeof ICONS, string, string, string][] = [
  ["raven", "Fetch", "Odin's ravens fly to GitHub and bring back the project's Python files.",
    "The whole repository arrives as one archive through Odin's relay, which only passes GitHub's own download through. If the relay is down, the file list comes from GitHub's API and the files sixteen at a time; jsDelivr stands in if GitHub's API is down."],
  ["tree", "Read", "Every file is split into its functions, methods and classes.",
    "Tree-sitter, compiled to WebAssembly, parses on up to four threads, exactly like the Python engine. Big repositories are searchable while they are still loading."],
  ["ansuz", "Index", "A word index is built, so any word in the report can be looked up instantly.",
    "A code-aware BM25 index: snake_case and camelCase names are split into words and also kept whole, so both prose and exact names match."],
  ["shield", "Rank", "A model trained on thousands of real bugs weighs the clues and answers in milliseconds.",
    "LambdaMART, shipped as JSON trees, over 33 signals: keyword scores for the issue, its title and quoted code, whether a traceback or the issue names the function, file-level evidence and the shape of the code."],
  ["eye", "Understand", "In the background, Odin learns what every function means, to find code the report never names.",
    "A static code-embedding model (16.8 MB, downloaded once) embeds every function in seconds; a second ranker adds how close each function is in meaning to the issue."],
  ["ansuz", "Reread", "The top 20 get a closer read, the way a developer would skim them.",
    "A small language model (MiniLM: 45 MB on a GPU through WebGPU, 23 MB on the CPU, downloaded once) embeds the issue and the top 20 functions; a third ranker reorders them with that evidence. A file ranker orders whole files for the Files view."],
  ["raven", "Remember", "The next visit to the same repository is instant.",
    "Parsed repositories are cached by git tree hash in IndexedDB. Everything runs in background threads, so the page never freezes."],
];

export function HowItWorks({ summary }: { summary: Summary | null }) {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  return (
    <div class="container" ref={root}>
      <PageHero kicker="How it works" title="From bug report to the right function">
        <p>
          A ranking cascade: cheap lexical scoring over every function, then learned and neural models over progressively smaller
          candidate pools. The full pipeline runs on a GPU; a lighter version, with its own rankers, runs in your browser.
        </p>
      </PageHero>

      <section class="block reveal">
        <p class="kicker">In your browser</p>
        <h2>What happens when you press Search</h2>
        <p class="section-lede">When you <a href={href("search")}>search a repository</a>, everything below runs in Web Workers in your tab. The only server of ours is the relay that passes the repository download through, and your bug report is never sent anywhere.</p>
        <ol class="journey">
          {JOURNEY.map(([icon, title, plain, detail], i) => (
            <li key={title} class="reveal" style={{ "--d": `${i * 0.08}s` }}>
              <span class="journey-node"><Icon name={icon} /></span>
              <div>
                <h3>{title} <span class="journey-sub">{plain}</span></h3>
                <p class="tech">{detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section class="card frame block reveal">
        <p class="kicker">The full pipeline</p>
        <h2>Five stages, each one smarter</h2>
        <p class="card-lede">Evaluated on the 291 SWE-bench Lite issues with a function-level gold label. Select a stage for its candidate pool, model, metrics and latency.</p>
        {summary ? <Pipeline summary={summary} /> : <p class="muted">Loading…</p>}
      </section>

      <section class="block reveal">
        <p class="kicker">Engineering</p>
        <h2>What makes it fast</h2>
        <Highlights />
      </section>

      <section class="block reveal">
        <p class="kicker">Things we tried</p>
        <h2>What worked</h2>
        <p class="section-lede">Every change was measured on held-out bugs with a paired bootstrap before it shipped. These made the cut.</p>
        <Worked summary={summary} />
      </section>

      <section class="block reveal">
        <p class="kicker">Things we tried</p>
        <h2>What didn't work</h2>
        <p class="section-lede">Negative results, kept because they explain the design as much as the wins do.</p>
        <Lessons />
      </section>
    </div>
  );
}
