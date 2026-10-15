import { useEffect, useState } from "preact/hooks";
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
      Live: on {w.bugs} bugs fixed in popular Python projects in the last 30 days, the changed function was in Odin's top 10 for{" "}
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
        Every night, Odin collects bugs that popular Python projects fixed in the past week, runs this website's pipeline at the commit
        before each fix, and checks whether a function the fix changed is in its top 10. These bugs are newer than every model Odin uses,
        and nothing is tuned on them.
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
      <p class="note">
        {w.merged ? `Fixes merged ${w.merged[0]} to ${w.merged[1]}. ` : ""}Updated {new Date(live.generated).toLocaleDateString(undefined, { dateStyle: "medium" })}.
      </p>
    </section>
  );
}
