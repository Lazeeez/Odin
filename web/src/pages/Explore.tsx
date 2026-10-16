import { useEffect, useState } from "preact/hooks";
import { type Dataset, Explorer } from "../components/Explorer.tsx";
import { Icon } from "../components/Myth.tsx";
import { PageHero } from "../components/PageHero.tsx";
import { Seg } from "../components/Seg.tsx";
import type { Summary } from "../lib/data.ts";
import { useLazy } from "../lib/lazy.ts";
import { href } from "../lib/router.ts";

const HOW: ["ansuz" | "eye" | "shield", string, string][] = [
  ["ansuz", "A real bug report", "SWE-bench Lite: 300 GitHub issues from 12 Python projects, each paired with the commit it was filed against."],
  ["eye", "Odin searches the code", "Each of five pipeline stages ranks every function in the repository snapshot at that base commit."],
  ["shield", "Checked against the real fix", "Gold labels are the functions and files whose lines the merged patch modifies, mapped onto the base commit's parse tree."],
];

export function Explore({ summary, linked, failed, mode: asked, set }: {
  summary: Summary | null; linked: string | null; failed: boolean; mode?: string | null; set?: string | null;
}) {
  const [hasLanguages, setHasLanguages] = useState(false);
  useEffect(() => {
    void fetch(`${import.meta.env.BASE_URL}data/issues-multi/index.json`, { method: "HEAD" }).then(
      (r) => setHasLanguages(r.ok && (r.headers.get("content-type") ?? "").includes("json")),
      () => {},
    );
  }, []);
  const dataset: Dataset = set === "languages" && hasLanguages ? "languages" : "lite";
  const chooseSet = (d: Dataset) => {
    location.hash = href("explore", null, d === "languages" ? { set: "languages" } : undefined);
  };
  const [mode, setMode] = useState<"explore" | "game">(asked === "game" ? "game" : "explore");
  // The mode lives in the address (#/explore?mode=game), so links, the palette and the nav agree.
  useEffect(() => setMode(asked === "game" ? "game" : "explore"), [asked]);
  const choose = (m: "explore" | "game") => {
    location.hash = href("explore", m === "game" ? null : linked, m === "game" ? { mode: "game" } : undefined);
  };
  const game = useLazy(() => import("../components/BeatOdin.tsx"), mode === "game");
  const Game = game?.default;
  return (
    <div class="container">
      <PageHero kicker="Explore" title="Watch Odin hunt real bugs">
        <p>
          Per-issue rankings from the evaluation runs, scored against the maintainers' patch: every stage's top 10 for 300 SWE-bench Lite
          issues (Python, the full GPU pipeline){hasLanguages ? ", and for 501 bugs in JavaScript, TypeScript, Go, Java and Rust (the website's own pipeline)" : ""}.
          The same data behind the benchmark numbers, one issue at a time.
        </p>
      </PageHero>
      <ol class="how-strip">
        {HOW.map(([icon, title, text], i) => (
          <li key={title} class="intro" style={{ "--d": `${0.3 + i * 0.1}s` }}>
            <Icon name={icon} />
            <span><b>{title}</b>{text}</span>
          </li>
        ))}
      </ol>
      <div class="mode-row">
        <Seg label="Mode" value={mode} onChange={choose} options={[["explore", "Explore a bug"], ["game", "Beat Odin"]] as const} />
        <span class="muted small">{mode === "game" ? "Guess the file the fix changed, then see what Odin picked." : "Step through one bug and every stage's answer."}</span>
      </div>
      {failed && <p class="error-text">Couldn't load the benchmark data. Try reloading the page.</p>}
      {mode === "explore" && hasLanguages && (
        <div class="mode-row">
          <Seg label="Bugs" value={dataset} onChange={chooseSet} options={[["lite", "SWE-bench Lite · Python"], ["languages", "Five more languages"]] as const} />
          <span class="muted small">{dataset === "languages" ? "SWE-bench Multilingual and SWE-PolyBench, ranked by the website's pipeline." : "Ranked by the full GPU pipeline."}</span>
        </div>
      )}
      {mode === "game" ? (Game ? <Game /> : <p class="muted">Loading the game…</p>)
        : summary || dataset === "languages" ? <Explorer key={dataset} summary={summary} linked={linked} dataset={dataset} /> : !failed && <p class="muted">Loading…</p>}
    </div>
  );
}
