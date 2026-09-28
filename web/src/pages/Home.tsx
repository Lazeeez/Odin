import { useState } from "preact/hooks";
import { type Lite, type Summary, stagesAt } from "../lib/data.ts";
import { pct } from "../lib/format.ts";
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
        <button class="btn primary" type="submit">Search it</button>
      </div>
      <p class="quickstart-examples">
        or try {EXAMPLES.map((name, i) => (
          <span key={name}>{i > 0 && (i === EXAMPLES.length - 1 ? " or " : ", ")}<a href={href("search", null, { repo: name })}>{name}</a></span>
        ))}
      </p>
    </form>
  );
}

/** What a search looks like: real output for a real Flask bug, drawn as a product window. */
function Preview() {
  const rows: [string, string, string][] = [
    ["Flask.url_for", "src/flask/app.py", "name appears in the issue"],
    ["url_for", "src/flask/helpers.py", "name appears in the issue"],
    ["App.handle_url_build_error", "src/flask/sansio/app.py", ""],
    ["Request.blueprint", "src/flask/wrappers.py", ""],
  ];
  return (
    <div class="preview" aria-label="Example: searching pallets/flask for a bug report" role="img">
      <div class="preview-bar"><i /><i /><i /><span>pallets/flask · 440 functions</span></div>
      <div class="preview-body">
        <div class="preview-issue">
          <span class="preview-label">Bug report</span>
          <p>url_for fails to build a URL for a blueprint endpoint</p>
          <code>werkzeug.routing.BuildError: Could not build url for endpoint 'admin.index'</code>
        </div>
        <ol class="preview-results">
          {rows.map(([name, path, why], i) => (
            <li key={name}>
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

const FEATURES: [string, string, string][] = [
  ["M4 6h16M4 12h16M4 18h10", "Any public Python repository", "Paste a name or a link. Odin downloads the code, splits it into functions and indexes it in seconds."],
  ["M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z", "Private by design", "Everything runs in your browser. Your queries and the code never touch a server of ours."],
  ["M5 5h14v10H9l-4 4V5Z", "Reads bug reports like a developer", "Tracebacks, quoted names, error messages and module paths all count as evidence, not just keywords."],
  ["M13 3 5 14h6l-1 7 8-11h-6l1-7Z", "Instant, then smarter", "A learned ranker answers in milliseconds; a small language model then re-reads the best candidates."],
];

export function Home({ summary, lite }: { summary: Summary | null; lite: Lite | null }) {
  const fn = summary ? stagesAt(summary, "function").at(-1)! : null;
  const fl = summary ? stagesAt(summary, "file").at(-1)! : null;
  const browser = lite ? (lite.lite.stage2 ?? lite.lite.stage1)["hit@10"] : null;
  return (
    <>
      <section class="hero">
        <div class="container">
          <p class="badge">Open source · Runs in your browser · Python</p>
          <h1>Find the code behind any bug report.</h1>
          <p class="lede">
            Paste an issue, a traceback or a one-line description. Odin reads the repository and points you to the functions most likely
            to need the fix, with the evidence for each.
          </p>
          <QuickStart />
        </div>
        <div class="container wide"><Preview /></div>
      </section>

      <section class="section">
        <div class="container">
          <p class="kicker">Why Odin</p>
          <h2>Bug triage without the grep.</h2>
          <div class="features">
            {FEATURES.map(([icon, title, text]) => (
              <div class="feature" key={title}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon} /></svg>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section class="section alt">
        <div class="container">
          <p class="kicker">How it works</p>
          <h2>Three steps, a few seconds.</h2>
          <ol class="steps">
            <li><b>Point it at a repository.</b> Any public GitHub project with Python code, by name or link.</li>
            <li><b>Describe the bug.</b> Paste the issue, the stack trace, or just what went wrong.</li>
            <li><b>Open the right function.</b> Ranked results with the matching code and a link to the exact line on GitHub.</li>
          </ol>
          <a class="text-link" href={href("how")}>See what happens under the hood →</a>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <p class="kicker">Measured, not claimed</p>
          <h2>Tested on 300 real bugs it never trained on.</h2>
          <p class="section-lede">
            SWE-bench Lite: real GitHub issues from 12 Python projects including Django, scikit-learn, SymPy and pytest, each searched at
            the commit where the bug was reported.
          </p>
          <div class="tiles">
            <div class="tile"><span class="tile-label">Function to fix in the top 10</span><span class="tile-value">{fn ? pct(fn["hit@10"]) : "–"}</span><span class="tile-note">full pipeline</span></div>
            <div class="tile"><span class="tile-label">File to fix in the top 5</span><span class="tile-value">{fl ? pct(fl["hit@5"]) : "–"}</span><span class="tile-note">full pipeline</span></div>
            <div class="tile"><span class="tile-label">Function to fix in the top 10</span><span class="tile-value">{browser != null ? pct(browser) : "–"}</span><span class="tile-note">in your browser</span></div>
          </div>
          <a class="text-link" href={href("benchmarks")}>See the full benchmarks →</a>
        </div>
      </section>

      <section class="section cta-band">
        <div class="container narrow center">
          <h2>Try it on your repository.</h2>
          <p class="section-lede">No sign-up, no install. It takes about as long as reading this sentence.</p>
          <a class="btn primary large" href={href("search")}>Open Odin</a>
        </div>
      </section>
    </>
  );
}
