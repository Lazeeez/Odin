import { Explorer } from "../components/Explorer.tsx";
import type { Summary } from "../lib/data.ts";

export function Explore({ summary, linked, failed }: { summary: Summary | null; linked: string | null; failed: boolean }) {
  return (
    <div class="container">
      <header class="page-head">
        <p class="kicker">Explore</p>
        <h1>300 real bugs, every stage's answer</h1>
        <p>
          Pick an issue to see what each stage of the pipeline ranked in its top 10. Starred rows are what the maintainers' actual fix
          changed: watch them climb as the pipeline gets smarter.
        </p>
      </header>
      {failed && <p class="error-text">Couldn't load the benchmark data. Try reloading the page.</p>}
      {summary ? <Explorer summary={summary} linked={linked} /> : !failed && <p class="muted">Loading…</p>}
    </div>
  );
}
