import { useRef, useState } from "preact/hooks";
import { Bookmarklet } from "../components/Bookmarklet.tsx";
import { Seer } from "../components/Emblem.tsx";
import { Divider, HeroSky, ICONS, Icon, RuneRing } from "../components/Myth.tsx";
import { Tile } from "../components/Tile.tsx";
import { bestBrowserStage, type Lite, type Summary, stagesAt } from "../lib/data.ts";
import { useReveal } from "../lib/reveal.ts";
import { href } from "../lib/router.ts";

const EXAMPLES = ["pallets/flask", "psf/requests", "AtsushiSakai/PythonRobotics"];

function QuickStart() {
  const [repo, setRepo] = useState("");
  const go = (name: string) => {
    location.hash = href("search", null, { repo: name.trim() });
  };
  return (
    <form class="quickstart" onSubmit={(e) => { e.preventDefault(); if (repo.trim()) go(repo); }}>
      <div class="quickstart-box">
        <span class="quickstart-prefix" aria-hidden="true">github.com/</span>
        <input type="text" value={repo} onInput={(e) => setRepo(e.currentTarget.value)} placeholder="owner/repository" aria-label="GitHub repository"
          autoComplete="off" spellcheck={false} />
        <button class="btn primary sheen" type="submit">Search it</button>
      </div>
      <p class="quickstart-examples">
        or try {EXAMPLES.map((name, i) => (
          <span key={name}>{i > 0 && (i === EXAMPLES.length - 1 ? " or " : ", ")}<a href={href("search", null, { repo: name })}>{name}</a></span>
        ))}
      </p>
    </form>
  );
}

/**
 * What a search looks like: real output for a real Flask bug, drawn as a product window. When it
 * scrolls into view it plays the search: the eye scans, then the results land one by one.
 */
function Preview() {
  const rows: [string, string, string][] = [
    ["Flask.url_for", "src/flask/app.py", "name appears in the issue"],
    ["url_for", "src/flask/helpers.py", "name appears in the issue"],
    ["App.handle_url_build_error", "src/flask/sansio/app.py", ""],
    ["Request.blueprint", "src/flask/wrappers.py", ""],
  ];
  return (
    <div class="preview reveal" aria-label="Example: searching pallets/flask for a bug report" role="img">
      <div class="preview-bar">
        <i /><i /><i /><span>pallets/flask · 440 functions</span>
        <span class="preview-state">
          <span class="scan"><Seer size="sm" /> searching</span>
          <span class="done">4 found in 38 ms</span>
        </span>
      </div>
      <div class="preview-body">
        <div class="preview-issue">
          <span class="preview-label">Bug report</span>
          <p>url_for fails to build a URL for a blueprint endpoint</p>
          <code>werkzeug.routing.BuildError: Could not build url for endpoint 'admin.index'</code>
        </div>
        <ol class="preview-results">
          {rows.map(([name, path, why], i) => (
            <li key={name} style={{ "--i": i }}>
              <span class="rank">{i + 1}</span>
              <span class="qual">{name}</span>
              <span class="path">{path}</span>
              {why && <span class="reason">{why}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

const FEATURES: [keyof typeof ICONS, string, string][] = [
  ["raven", "Any public Python repository", "One GitHub API call lists the tree; files stream in 16 at a time, or as a single tarball through an optional relay, and Tree-sitter (WebAssembly) splits them into functions on up to four worker threads."],
  ["ansuz", "Reads bug reports like a developer", "Traceback frames, backticked identifiers, dotted module paths and error strings are extracted as separate signals, scored with BM25 over the issue, its title and its quoted code, then weighed by a LambdaMART ranker."],
  ["eye", "Sees meaning, not just words", "In the background a 16 MB int8 static code-embedding model (Model2Vec potion-code-16M) embeds every function at thousands per second; cosine similarity to the issue feeds a second ranker."],
  ["shield", "Private by design", "No backend: parsing, indexing, embedding and ranking run in Web Workers. Repositories are cached in IndexedDB by git tree hash, and queries never leave the tab."],
];

const STEPS: [string, string, string][] = [
  ["I", "Point it at a repository.", "owner/name or any GitHub URL, including a branch or a subdirectory. The tree resolves to a commit and the parsed index is cached by its hash."],
  ["II", "Describe the bug.", "The text is tokenized code-aware: snake_case and camelCase names are split into words and also kept whole; tracebacks and quoted names become their own features."],
  ["III", "Open the right function.", "Functions are ranked by gradient-boosted trees over lexical, mention and embedding features, each with the matched terms highlighted and a link to the exact line."],
];

const TITLE = ["Find", "the", "code", "behind", "any", "bug", "report."];

export function Home({ summary, lite }: { summary: Summary | null; lite: Lite | null }) {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  const fn = summary ? stagesAt(summary, "function").at(-1)! : null;
  const fl = summary ? stagesAt(summary, "file").at(-1)! : null;
  const browser = lite ? bestBrowserStage(lite.held_out.unseen)["hit@10"] : null;
  return (
    <div ref={root}>
      <section class="hero">
        <HeroSky />
        <RuneRing />
        <div class="container hero-text">
          <p class="badge intro" style={{ "--d": ".05s" }}>Open source · Runs in your browser · Python</p>
          <h1 aria-label={TITLE.join(" ")}>
            {TITLE.map((w, i) => <span key={i} class="word" aria-hidden="true" style={{ "--i": i }}>{w} </span>)}
          </h1>
          <p class="lede intro soft" style={{ "--d": ".3s" }}>
            Paste an issue, a traceback or a one-line description. Odin parses the repository into functions and ranks every one with BM25,
            learned rankers and code embeddings, showing the evidence behind each result.
          </p>
          <div class="intro" style={{ "--d": ".6s" }}><QuickStart /></div>
        </div>
        <div class="container wide"><Preview /></div>
      </section>

      <section class="epigraph reveal">
        <Divider />
        <blockquote>
          <p>“Wits must he have who wanders wide.”</p>
          <cite>Hávamál, the sayings of Odin</cite>
        </blockquote>
      </section>

      <section class="section">
        <div class="container">
          <div class="reveal">
            <p class="kicker">Why Odin</p>
            <h2>Bug triage without the grep.</h2>
            <p class="section-lede">A ranking cascade over every function in the repository: lexical retrieval, learned ranking and semantic similarity, computed on your device.</p>
          </div>
          <div class="features">
            {FEATURES.map(([icon, title, text], i) => (
              <div class="feature frame reveal" key={title} style={{ "--d": `${i * 0.1}s` }}>
                <Icon name={icon} />
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section class="section alt">
        <div class="container">
          <div class="reveal">
            <p class="kicker">How it works</p>
            <h2>Three steps, a few seconds.</h2>
          </div>
          <ol class="steps">
            {STEPS.map(([n, title, text], i) => (
              <li key={n} class="frame reveal" style={{ "--d": `${i * 0.12}s` }}>
                <span class="numeral" aria-hidden="true">{n}</span><b>{title}</b> {text}
              </li>
            ))}
          </ol>
          <a class="text-link" href={href("how")}>See what happens under the hood →</a>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="reveal">
            <p class="kicker">From GitHub</p>
            <h2>One click from any issue.</h2>
          </div>
          <div class="reveal"><Bookmarklet /></div>
        </div>
      </section>

      <section class="section night">
        <div class="container">
          <div class="reveal">
            <p class="kicker">Measured, not claimed</p>
            <h2>Tested on real bugs it never trained on.</h2>
            <p class="section-lede">
              SWE-bench Lite: 300 real GitHub issues from 12 Python projects including Django, scikit-learn, SymPy and pytest, each searched
              at the commit where the bug was reported. The browser ranker is also tested on 30 projects kept out of its training entirely.
            </p>
          </div>
          <div class="tiles reveal">
            <Tile label="Function to fix in the top 10" value={fn ? fn["hit@10"] : null} note="full pipeline" />
            <Tile label="File to fix in the top 5" value={fl ? fl["hit@5"] : null} note="full pipeline" />
            <Tile label="Function to fix in the top 10" value={browser} note="in your browser, on 30 projects it never trained on" />
          </div>
          <a class="text-link" href={href("benchmarks")}>See the full benchmarks →</a>
        </div>
      </section>

      <section class="section cta-band">
        <div class="container narrow center reveal">
          <Icon name="tree" />
          <h2>Send the ravens to your repository.</h2>
          <a class="btn primary large sheen" href={href("search")}>Open Odin</a>
        </div>
      </section>
    </div>
  );
}
