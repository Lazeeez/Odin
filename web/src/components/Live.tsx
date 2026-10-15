import { useEffect, useRef, useState } from "preact/hooks";
import { fetchLive, LIVE_MIN_BUGS, type LiveSummary, type LiveWindow } from "../lib/feedback.ts";
import { pct } from "../lib/format.ts";
import { href } from "../lib/router.ts";
import { Tile } from "./Tile.tsx";

export function useLive(): LiveSummary | null {
  const [live, setLive] = useState<LiveSummary | null>(null);
  useEffect(() => {
    void fetchLive().then(setLive);
  }, []);
  return live;
}

const enough = (w: LiveWindow | undefined): w is LiveWindow & Required<Pick<LiveWindow, "function">> =>
  !!w && w.bugs >= LIVE_MIN_BUGS && !!w.function;

const interval = (ci: [number, number]) => `95% interval ${pct(ci[0])} to ${pct(ci[1])}`;

export function LiveLine({ live }: { live: LiveSummary | null }) {
  const w = live?.last_30_days;
  if (!enough(w)) return null;
  return (
    <p class="quickstart-usage">
      Live: on {w.bugs} bugs fixed in popular open-source projects in the last 30 days, the changed function was in Odin's top 10 for{" "}
      <a href={href("benchmarks")}>{pct(w.function["hit@10"])}</a>.
    </p>
  );
}

export function LiveSection({ live }: { live: LiveSummary }) {
  const w = live.last_30_days;
  const trained = live.all_time_trained_projects;
  const unseen = live.all_time_new_projects;
  return (
    <section class="card frame block reveal">
      <p class="kicker">Live</p>
      <h2>On bugs fixed this month</h2>
      <p class="card-lede">
        Every night, Odin collects bugs that popular open-source projects in Python, JavaScript, TypeScript, Go, Java and Rust fixed in
        the past week, runs this website's pipeline at the commit before each fix, and checks whether a function the fix changed is in its
        top 10. These bugs are newer than every model Odin uses, and nothing is tuned on them.
      </p>
      {enough(w) ? (
        <div class="tiles">
          <Tile label="Function to fix in the top 10" value={w.function["hit@10"]} note={`${w.bugs} bugs from ${w.projects} projects; ${interval(w.function["hit@10_ci95"])}`} />
          <Tile label="Function to fix ranked first" value={w.function["hit@1"]} note={`${w.bugs} bugs, last 30 days`} />
          {w.file && <Tile label="File to fix in the top 10" value={w.file["hit@10"]} note={interval(w.file["hit@10_ci95"])} />}
        </div>
      ) : (
        <p class="note">
          {w.bugs} bug{w.bugs === 1 ? "" : "s"} scored in the last 30 days so far; the percentage appears once there are {LIVE_MIN_BUGS}.
        </p>
      )}
      {enough(trained) && enough(unseen) && (
        <p class="note">
          All time: {pct(trained.function["hit@10"])} of {trained.bugs} bugs in projects the website's rankers trained on (on older
          issues), {pct(unseen.function["hit@10"])} of {unseen.bugs} bugs in projects they never saw.
        </p>
      )}
      {live.history && live.history.length > 1 && <Trend history={live.history} />}
      {live.last_30_days_by_language && Object.keys(live.last_30_days_by_language).length > 1 && (
        <ByLanguage windows={live.last_30_days_by_language} />
      )}
      <p class="note">
        {w.merged ? `Fixes merged ${w.merged[0]} to ${w.merged[1]}. ` : ""}Updated {new Date(live.generated).toLocaleDateString(undefined, { dateStyle: "medium" })}.
      </p>
    </section>
  );
}

const LANGUAGES: Record<string, string> = { go: "Go", java: "Java", javascript: "JavaScript", python: "Python", rust: "Rust", typescript: "TypeScript" };

function ByLanguage({ windows }: { windows: Record<string, LiveWindow> }) {
  const rows = Object.entries(windows).sort((a, b) => b[1].bugs - a[1].bugs);
  return (
    <>
      <h3 class="subhead">By language, last 30 days</h3>
      <div class="table-wrap" tabIndex={0} role="region" aria-label="Live accuracy by language">
        <table>
          <thead><tr><th>Language</th><th>Bugs</th><th>Projects</th><th>Function in the top 10</th><th>95% interval</th></tr></thead>
          <tbody>
            {rows.map(([lang, x]) => (
              <tr key={lang}>
                <td>{LANGUAGES[lang] ?? lang}</td>
                <td class="num">{x.bugs}</td>
                <td class="num">{x.projects}</td>
                <td class="num">{x.function ? pct(x.function["hit@10"]) : "–"}</td>
                <td class="num">{x.function ? `${pct(x.function["hit@10_ci95"][0])} to ${pct(x.function["hit@10_ci95"][1])}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">Languages with few bugs so far have wide intervals; they narrow as nights accumulate.</p>
    </>
  );
}

function Trend({ history }: { history: NonNullable<LiveSummary["history"]> }) {
  const figure = useRef<HTMLElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = figure.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const points = history.filter((h) => h.last_30_days.function);
  if (points.length < 2) return null;
  const [h, padL, padR, padT, padB] = [220, 44, 12, 12, 28];
  const x = (i: number) => padL + (i / (points.length - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - v) * (h - padT - padB);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.last_30_days.function!["hit@10"]).toFixed(1)}`).join(" ");
  const band = [
    ...points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.last_30_days.function!["hit@10_ci95"][1]).toFixed(1)}`),
    ...points.slice().reverse().map((p, j) => `L${x(points.length - 1 - j).toFixed(1)},${y(p.last_30_days.function!["hit@10_ci95"][0]).toFixed(1)}`),
    "Z",
  ].join(" ");
  return (
    <>
      <h3 class="subhead">Over time</h3>
      <figure class="trend" ref={figure}>
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Function in the top 10 over the previous 30 days, night by night, with its 95% interval">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line class="grid" x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} />
              <text class="axis" x={padL - 8} y={y(v) + 4} text-anchor="end">{Math.round(v * 100)}%</text>
            </g>
          ))}
          <path class="band" d={band} />
          <path class="series" d={line} />
          {points.map((p, i) => (
            <g key={p.date}>
              <circle class="hit-area" cx={x(i)} cy={y(p.last_30_days.function!["hit@10"])} r="10">
                <title>{`${p.date}: ${pct(p.last_30_days.function!["hit@10"])} of ${p.last_30_days.bugs} bugs (${p.scored} scored that night)`}</title>
              </circle>
              <circle class="dot" cx={x(i)} cy={y(p.last_30_days.function!["hit@10"])} r="4" />
            </g>
          ))}
          <text class="axis" x={padL} y={h - 6}>{points[0].date}</text>
          <text class="axis" x={w - padR} y={h - 6} text-anchor="end">{points[points.length - 1].date}</text>
        </svg>
        <figcaption class="note">Function in the top 10 over the previous 30 days, as of each night; the band is its 95% interval.</figcaption>
      </figure>
      <details class="trend-table">
        <summary>Show the numbers</summary>
        <div class="table-wrap" tabIndex={0} role="region" aria-label="Live accuracy by night">
          <table>
            <thead><tr><th>Night</th><th>Scored that night</th><th>Bugs in the 30 days</th><th>Function in the top 10</th></tr></thead>
            <tbody>
              {points.slice().reverse().map((p) => (
                <tr key={p.date}>
                  <td>{p.date}</td>
                  <td class="num">{p.scored}</td>
                  <td class="num">{p.last_30_days.bugs}</td>
                  <td class="num">{pct(p.last_30_days.function!["hit@10"])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
