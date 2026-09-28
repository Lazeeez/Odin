import { useEffect, useMemo, useState } from "preact/hooks";
import { type Issue, type IssueSummary, getJSON } from "../lib/data.ts";
import { load, save } from "../lib/storage.ts";
import { Report } from "./Report.tsx";

interface Round {
  issue: Issue;
  choices: string[];
  gold: Set<string>;
  /** Odin's first file under its best stage, and where it ranked the real one. */
  odinPick: string;
  odinRank: number | null;
}
type Score = { rounds: number; you: number; odin: number };

const shuffle = <T,>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * A round: one real bug, six files (the file the fix touched and five decoys taken from Odin's
 * own rankings, so they are plausible), and Odin's answer from the evaluation run.
 */
async function newRound(index: IssueSummary[]): Promise<Round> {
  for (let tries = 0; tries < 8; tries++) {
    const pick = index[Math.floor(Math.random() * index.length)];
    const issue = await getJSON<Issue>(`data/issues/${encodeURIComponent(pick.id)}.json`);
    const stages = Object.values(issue.files);
    const best = stages.at(-1);
    if (!best?.length || !issue.gold_files.length) continue;
    const gold = new Set(issue.gold_files);
    const decoys = [...new Set(stages.flat())].filter((f) => !gold.has(f));
    if (decoys.length < 5) continue;
    const answer = issue.gold_files[Math.floor(Math.random() * issue.gold_files.length)];
    const rank = best.findIndex((f) => gold.has(f));
    return {
      issue, gold, choices: shuffle([answer, ...shuffle(decoys.slice(0, 12)).slice(0, 5)]),
      odinPick: best[0], odinRank: rank < 0 ? null : rank + 1,
    };
  }
  throw new Error("no playable bug found");
}

export default function BeatOdin() {
  const [index, setIndex] = useState<IssueSummary[] | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [guess, setGuess] = useState<string | null>(null);
  const [score, setScore] = useState<Score>(() => load("beatOdin", { rounds: 0, you: 0, odin: 0 }));
  const [error, setError] = useState(false);

  useEffect(() => {
    getJSON<IssueSummary[]>("data/issues/index.json").then(setIndex, () => setError(true));
  }, []);
  const next = () => {
    if (!index) return;
    setGuess(null);
    setRound(null);
    newRound(index).then(setRound, () => setError(true));
  };
  useEffect(next, [index]);

  const answer = (file: string) => {
    if (!round || guess) return;
    setGuess(file);
    const s = { rounds: score.rounds + 1, you: score.you + (round.gold.has(file) ? 1 : 0), odin: score.odin + (round.gold.has(round.odinPick) ? 1 : 0) };
    setScore(s);
    save("beatOdin", s);
  };

  const text = useMemo(() => round?.issue.text.replace(/\r/g, "") ?? "", [round]);
  const nl = text.indexOf("\n");
  const title = nl < 0 ? text : text.slice(0, nl);
  const body = nl < 0 ? "" : text.slice(nl + 1).trim();

  if (error) return <p class="muted">Couldn't load a bug. Try again in a moment.</p>;
  return (
    <div class="game">
      <div class="game-score frame" aria-live="polite">
        <span><b>{score.you}</b> you</span>
        <span class="vs">vs</span>
        <span><b>{score.odin}</b> Odin</span>
        <span class="muted small">after {score.rounds} {score.rounds === 1 ? "round" : "rounds"}</span>
        {score.rounds > 0 && (
          <button type="button" class="link-btn" onClick={() => { const z = { rounds: 0, you: 0, odin: 0 }; setScore(z); save("beatOdin", z); }}>Reset</button>
        )}
      </div>
      {!round ? <p class="muted">Choosing a bug…</p> : (
        <div class="story-card frame">
          <p class="step-label"><span>?</span> Which file did the fix change?</p>
          <h2 class="bug-title">{title}</h2>
          <p class="bug-meta"><span class="bug-id">{round.issue.id}</span> · {round.issue.repo}</p>
          {body && <Report text={body} />}
          <p class="story-lede">
            Six files from the project at the commit the bug was filed against. One of them was changed by the maintainers' fix; the
            others are files Odin itself considered. Odin's answer is its top file from the evaluation run.
          </p>
          <ul class="choices">
            {round.choices.map((f) => {
              const state = !guess ? "" : round.gold.has(f) ? "right" : f === guess ? "wrong" : "";
              return (
                <li key={f}>
                  <button type="button" class={`choice ${state}${f === round.odinPick && guess ? " odin" : ""}`} disabled={!!guess} onClick={() => answer(f)}>
                    <span class="n">{f.split("/").pop()}</span><span class="p">{f}</span>
                    {guess && f === round.odinPick && <span class="tag">Odin's pick</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {guess && (
            <div class="reveal-box">
              <p class={`verdict${round.gold.has(guess) ? "" : " miss"}`}>
                {round.gold.has(guess) ? "You found it." : "Not this time."}{" "}
                {round.gold.has(round.odinPick) ? "Odin ranked the fixed file first." : round.odinRank ? `Odin had it at #${round.odinRank}.` : "Odin missed it too."}
              </p>
              <button type="button" class="btn primary sheen" onClick={next}>Next bug</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
