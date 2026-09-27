import { useEffect, useState } from "preact/hooks";
import { Engineering } from "./components/Engineering.tsx";
import { Explorer } from "./components/Explorer.tsx";
import { LiveSearch } from "./components/LiveSearch.tsx";
import { Nav, REPO_URL } from "./components/Nav.tsx";
import { Hero, Pipeline } from "./components/Overview.tsx";
import { Results } from "./components/Results.tsx";
import { type Lite, type Summary, getJSON, stagesAt } from "./lib/data.ts";

export function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lite, setLite] = useState<Lite | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getJSON<Summary>("data/summary.json").then(setSummary, () => setFailed(true));
    getJSON<Lite>("data/lite.json").then(setLite, () => {});
  }, []);
  const fullHit10 = summary ? stagesAt(summary, "function").at(-1)!["hit@10"] : null;
  return (
    <>
      <a class="skip" href="#try">Skip to the search</a>
      <Nav />
      <main id="top">
        <Hero summary={summary} />
        <section id="pipeline" class="band">
          <h2>How it works</h2>
          <p class="sub">A ranking cascade: each stage is more expensive per candidate and sees fewer of them. Click a stage.</p>
          {summary ? <Pipeline summary={summary} /> : <div class="stage-detail muted">Loading…</div>}
        </section>
        <section id="results">
          <h2>Results, stage by stage</h2>
          <p class="sub">SWE-bench Lite test set. Bars show the mean; whiskers are 95% bootstrap intervals where available.</p>
          {failed && <p class="error-text">Could not load the results data.</p>}
          {summary && <Results summary={summary} />}
        </section>
        <LiveSearch lite={lite} fullHit10={fullHit10} />
        {summary && <Explorer summary={summary} />}
        <Engineering />
      </main>
      <footer>
        <p>
          Built with Python, Tree-sitter, SciPy, LightGBM, PyTorch, TypeScript and Preact. Data:{" "}
          <a href="https://www.swebench.com" target="_blank" rel="noopener">SWE-bench</a>.{" "}
          <a href={REPO_URL} target="_blank" rel="noopener">Source on GitHub</a>.
        </p>
      </footer>
    </>
  );
}
