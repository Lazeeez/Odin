import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useInView } from "../hooks/useInView.ts";
import { type Issue, type IssueSummary, type Summary, getJSON, stagesAt } from "../lib/data.ts";

type Outcome = "" | "rescued" | "first" | "missed";

const fixUrl = (id: string, repo: string) => `https://github.com/${repo}/pull/${id.split("-").pop()}`;
const firstRank = (list: string[] | undefined, gold: string[]) => {
  const g = new Set(gold);
  const i = (list ?? []).findIndex((x) => g.has(x));
  return i < 0 ? null : i + 1;
};

// One fetch per issue, shared by hover-prefetch and selection.
const details = new Map<string, Promise<Issue>>();
const loadIssue = (id: string) => {
  let p = details.get(id);
  if (!p) {
    p = getJSON<Issue>(`data/issues/${encodeURIComponent(id)}.json`);
    p.catch(() => details.delete(id));
    details.set(id, p);
  }
  return p;
};

function Column({ label, list, gold, full, what }: { label: string; list: string[]; gold: string[]; full: boolean; what: string }) {
  const r = firstRank(list, gold);
  const g = new Set(gold);
  return (
    <div class="stage-col">
      <h4>{label}</h4>
      <div class="first">{what}: <b>{r ? `#${r}` : "not in top 10"}</b></div>
      <ol>
        {list.map((x) => <li key={x} class={g.has(x) ? "gold" : ""} title={x}>{full ? x : x.split("::")[1] ?? x}</li>)}
      </ol>
    </div>
  );
}

function IssueView({ issue, summary }: { issue: Issue; summary: Summary }) {
  const gold = issue.gold_functions.length ? issue.gold_functions : issue.gold_files;
  return (
    <>
      <div class="card">
        <h3>{issue.id}</h3>
        <div class="muted small">{issue.repo} · <a href={fixUrl(issue.id, issue.repo)} target="_blank" rel="noopener">fix on GitHub ↗</a></div>
        <div class="issue-text">{issue.text}</div>
      </div>
      <div class="card">
        <b>What the real fix changed</b>
        <div class="gold-list">{gold.map((g) => <div key={g}>{g}</div>)}</div>
        {!issue.gold_functions.length && <p class="muted small">Module-level change only: scored at file level.</p>}
      </div>
      <div class="stages-grid">
        {stagesAt(summary, "function").filter((s) => issue.functions[s.id]).map((s) => (
          <Column key={s.id} label={s.label} list={issue.functions[s.id]} gold={issue.gold_functions} full={false} what="first fix location" />
        ))}
      </div>
      <div class="stages-grid" style={{ marginTop: "12px" }}>
        {Object.entries(issue.files).map(([id, list]) => (
          <Column key={id} label={`Files · ${stagesAt(summary, "file").find((x) => x.id === id)?.label ?? id}`} list={list} gold={issue.gold_files} full what="fixed file" />
        ))}
      </div>
    </>
  );
}

export function Explorer({ summary }: { summary: Summary }) {
  const section = useRef<HTMLElement>(null);
  const deepLinked = location.hash.startsWith("#issue=");
  const inView = useInView(section, "600px", !deepLinked);
  const [index, setIndex] = useState<IssueSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [filter, setFilter] = useState("");
  const [repo, setRepo] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("");

  useEffect(() => {
    if ((inView || deepLinked) && !index) getJSON<IssueSummary[]>("data/issues/index.json").then(setIndex, () => setError(true));
  }, [inView]);

  const shown = useMemo(() => {
    if (!index) return [];
    const f = filter.toLowerCase();
    return index.filter((it) => (!repo || it.repo === repo) && (!f || it.id.includes(f) || it.title.toLowerCase().includes(f)) && (!outcome || it[outcome]));
  }, [index, filter, repo, outcome]);

  const select = (id: string, push = true) => {
    setSelected(id);
    if (push) history.replaceState(null, "", `${location.pathname}${location.search}#issue=${id}`);
  };

  // First open: a deep-linked issue, or one that shows the pipeline at work.
  useEffect(() => {
    if (!index || selected) return;
    const linked = deepLinked ? decodeURIComponent(location.hash.slice(7)) : null;
    if (linked && index.some((i) => i.id === linked)) {
      select(linked, false);
      section.current?.scrollIntoView();
      return;
    }
    select((index.find((i) => i.rescued && i.first) ?? index[0]).id, false);
  }, [index]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    loadIssue(selected).then((it) => live && setIssue(it), () => live && setError(true));
    return () => {
      live = false;
    };
  }, [selected]);

  const repos = useMemo(() => [...new Set((index ?? []).map((i) => i.repo))].sort(), [index]);

  return (
    <section id="explorer" ref={section}>
      <h2>Explorer: 300 real bugs, every stage's answer</h2>
      <p class="sub">Pick an issue. Gold marks what the maintainers' actual fix changed. Watch it climb as the pipeline gets smarter.</p>
      <div class="explorer">
        <aside class="issue-list">
          <input type="search" placeholder="Filter by id or title…" aria-label="Filter issues" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
          <div class="filter-row">
            <select aria-label="Repository filter" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
              <option value="">All repositories</option>
              {repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select aria-label="Outcome filter" value={outcome} onChange={(e) => setOutcome(e.currentTarget.value as Outcome)}>
              <option value="">Any outcome</option>
              <option value="rescued">Missed by BM25, found by final</option>
              <option value="first">Final system ranks it #1</option>
              <option value="missed">Final system misses (top 10)</option>
            </select>
          </div>
          <div class="filter-row">
            <span class="issue-count">{index ? `${shown.length} of ${index.length} issues` : ""}</span>
            <button class="link-btn" type="button" disabled={!shown.length} onClick={() => select(shown[Math.floor(Math.random() * shown.length)].id)}>Random bug</button>
          </div>
          <ul>
            {shown.map((it) => (
              <li key={it.id} class={it.id === selected ? "on" : ""} tabIndex={0} role="button"
                onClick={() => select(it.id)} onKeyDown={(e) => e.key === "Enter" && select(it.id)}
                onPointerEnter={() => void loadIssue(it.id)} onFocus={() => void loadIssue(it.id)}>
                <span class="iid">{it.id}</span>
                <span class="ititle">{it.title}</span>
              </li>
            ))}
          </ul>
        </aside>
        <div class="issue-view" aria-live="polite">
          {error && <p class="muted">Could not load the issue data.</p>}
          {!issue && !error && <p class="muted">Loading issues…</p>}
          {issue && <IssueView issue={issue} summary={summary} />}
        </div>
      </div>
    </section>
  );
}
