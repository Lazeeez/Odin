import { useEffect, useMemo, useState } from "preact/hooks";
import { type Issue, type IssueSummary, type Stage, type Summary, getJSON, stagesAt } from "../lib/data.ts";
import { href, replaceHash } from "../lib/router.ts";
import { inlineCode } from "../lib/format.ts";
import { plainName } from "../lib/stages.ts";
import { Report } from "./Report.tsx";

type Outcome = "" | "first" | "rescued" | "missed";

const OUTCOMES: [Outcome, string][] = [
  ["", "All bugs"],
  ["first", "Odin ranks the fix #1"],
  ["rescued", "Only the smarter stages find it"],
  ["missed", "Odin misses it"],
];

const fixUrl = (id: string, repo: string) => `https://github.com/${repo}/pull/${id.split("-").pop()}`;
const project = (repo: string) => repo.split("/")[1] ?? repo;
const firstRank = (list: string[] | undefined, gold: string[]) => {
  const g = new Set(gold);
  const i = (list ?? []).findIndex((x) => g.has(x));
  return i < 0 ? null : i + 1;
};
/** `path::Qual.name` → name and path, for people who read names before paths. */
const split = (id: string) => {
  const [path, name] = id.includes("::") ? id.split("::", 2) : [id, ""];
  return { name: name || path.split("/").pop()!, path };
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

/** One sentence a newcomer can read: how the first and the last stage did on this bug. */
function verdict(first: number | null, last: number | null, best: { name: string; rank: number } | null, unit: string): string {
  if (last === 1 && first === 1) return `An easy one: even plain keyword search put the ${unit} first.`;
  if (last === 1 && first == null) return `Plain keyword search didn't find the ${unit} at all. Odin's full pipeline put it first.`;
  if (last === 1) return `Plain keyword search had the ${unit} at #${first}. Odin's full pipeline lifted it to #1.`;
  if (last != null && first == null) return `Plain keyword search missed the ${unit}. Odin's full pipeline found it at #${last}.`;
  if (last != null && first != null && last < first) return `Keyword search had the ${unit} at #${first}; the full pipeline lifted it to #${last}.`;
  if (last != null) return `Keyword search already had the ${unit} at #${first}; the full pipeline has it at #${last}.`;
  if (best) return `A miss for the full pipeline, though “${best.name}” had the ${unit} at #${best.rank}.`;
  return `A miss: no stage put the ${unit} in its top 10. Some bugs are hard to find from the report alone.`;
}

const rr = (rank: number | null) => (rank ? 1 / rank : 0).toFixed(3);

/** Ten slots, best on the left; a gold diamond wherever the real fix is. */
function Ladder({ list, gold }: { list: string[]; gold: Set<string> }) {
  const hits = list.slice(0, 10).map((x, i) => (gold.has(x) ? i : -1)).filter((i) => i >= 0);
  return (
    <span class="ladder" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => <i key={i} class={hits.includes(i) ? (i === hits[0] ? "hit first" : "hit") : ""} />)}
    </span>
  );
}

function ClimbRow({ stage, list, gold, open, onToggle, file }: {
  stage: Stage; list: string[]; gold: Set<string>; open: boolean; onToggle: () => void; file: boolean;
}) {
  const r = firstRank(list, [...gold]);
  return (
    <li class={`climb-row${open ? " open" : ""}${r === 1 ? " top" : ""}`}>
      <button type="button" class="climb-head" aria-expanded={open} onClick={onToggle}>
        <span class="climb-name">
          <b>{plainName(stage.id, stage.label)}</b>
          <span dangerouslySetInnerHTML={{ __html: inlineCode(stage.blurb) }} />
        </span>
        <Ladder list={list} gold={gold} />
        <span class={`climb-rank${r ? "" : " miss"}`}>{r ? `#${r}` : "not in top 10"}</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {open && (
        <ol class="climb-list">
          {list.slice(0, 10).map((x) => {
            const { name, path } = file ? { name: x.split("/").pop()!, path: x } : split(x);
            return (
              <li key={x} class={gold.has(x) ? "gold" : ""}>
                <span class="n">{name}</span><span class="p">{path}</span>
                {gold.has(x) && <span class="tag">real fix</span>}
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

function Climb({ stages, lists, gold, file }: { stages: Stage[]; lists: Record<string, string[]>; gold: string[]; file: boolean }) {
  const shown = stages.filter((s) => lists[s.id]);
  const [open, setOpen] = useState<string | null>(null);
  const g = useMemo(() => new Set(gold), [gold]);
  return (
    <ol class="climb">
      {shown.map((s) => (
        <ClimbRow key={s.id} stage={s} list={lists[s.id]} gold={g} file={file} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
      ))}
    </ol>
  );
}

function IssueView({ issue, summary, onNext }: { issue: Issue; summary: Summary; onNext: () => void }) {
  const fnStages = stagesAt(summary, "function");
  const fileStages = stagesAt(summary, "file");
  const byFunction = issue.gold_functions.length > 0;
  const lists = byFunction ? issue.functions : issue.files;
  const gold = byFunction ? issue.gold_functions : issue.gold_files;
  const stages = (byFunction ? fnStages : fileStages).filter((s) => lists[s.id]);
  const ranks = stages.map((s) => firstRank(lists[s.id], gold));
  const first = ranks[0] ?? null;
  const last = ranks.at(-1) ?? null;
  const bestAt = ranks.reduce<number>((b, r, i) => (r != null && (b < 0 || r < ranks[b]!) ? i : b), -1);
  const best = bestAt >= 0 ? { name: plainName(stages[bestAt].id, stages[bestAt].label), rank: ranks[bestAt]! } : null;
  const unit = byFunction ? "fixed function" : "fixed file";

  const text = issue.text.replace(/\r/g, "");
  const nl = text.indexOf("\n");
  const title = (nl < 0 ? text : text.slice(0, nl)).trim();
  const body = (nl < 0 ? "" : text.slice(nl + 1)).trim();

  return (
    <div class="issue-view">
      <section class="story-card frame reveal in">
        <p class="step-label"><span>1</span> The bug report</p>
        <h2 class="bug-title">{title}</h2>
        <p class="bug-meta">
          <span class="bug-id">{issue.id}</span> · {issue.repo} · <a href={fixUrl(issue.id, issue.repo)} target="_blank" rel="noopener">the real fix on GitHub ↗</a>
        </p>
        {body && <Report text={body} />}
      </section>

      <section class="story-card frame reveal in">
        <p class="step-label"><span>2</span> The answer key</p>
        <p class="story-lede">
          The gold {byFunction ? "functions" : "files"}: every {byFunction ? "function or method" : "file"} whose lines the maintainers' patch modifies, located in
          the base commit's parse tree ({gold.length} here). The rankers never see them; they are only used to score the rankings.
        </p>
        <ul class="answer-key">
          {gold.map((x) => {
            const { name, path } = byFunction ? split(x) : { name: x.split("/").pop()!, path: x };
            return <li key={x}><span class="star" aria-hidden="true">★</span><span class="n">{name}</span><span class="p">{path}</span></li>;
          })}
        </ul>
      </section>

      <section class="story-card frame reveal in">
        <p class="step-label"><span>3</span> How each stage did</p>
        <p class={`verdict${last === 1 ? " win" : last == null ? " miss" : ""}`}>{verdict(first, last, best, unit)}</p>
        <p class="verdict-tech">
          reciprocal rank {rr(first)} → {rr(last)} · first gold hit {first ? `#${first}` : "> 10"} → {last ? `#${last}` : "> 10"}
        </p>
        <p class="story-lede">
          Each row is one stage's top-10 ranking for this issue, best on the left; diamonds mark gold units. The number is the rank of
          the first gold unit: its reciprocal, averaged over issues, is the MRR on the benchmarks page. Open a row for the list.
        </p>
        <Climb key={`${issue.id}-f`} stages={byFunction ? fnStages : fileStages} lists={lists} gold={gold} file={!byFunction} />
        {byFunction && Object.keys(issue.files).length > 0 && (
          <>
            <h3 class="subhead">And the file?</h3>
            <p class="story-lede">File-level rankings for the same issue, scored against the files the patch touches.</p>
            <Climb key={`${issue.id}-F`} stages={fileStages} lists={issue.files} gold={issue.gold_files} file />
          </>
        )}
      </section>

      <div class="story-next">
        <button type="button" class="btn primary sheen" onClick={onNext}>Show me another bug</button>
      </div>
    </div>
  );
}

function BugCard({ it, on, onPick }: { it: IssueSummary; on: boolean; onPick: () => void }) {
  const badge = it.first ? ["win", "#1"] : it.missed ? ["miss", "missed"] : it.rescued ? ["rescue", "found by smarter stages"] : ["", "top 10"];
  return (
    <li>
      <button type="button" class={`bug-card${on ? " on" : ""}`} onClick={onPick}
        onPointerEnter={() => void loadIssue(it.id)} onFocus={() => void loadIssue(it.id)}>
        <span class="bug-card-top"><span class="proj">{project(it.repo)}</span><span class={`badge-mini ${badge[0]}`}>{badge[1]}</span></span>
        <span class="bug-card-title">{it.title}</span>
      </button>
    </li>
  );
}

export function Explorer({ summary, linked }: { summary: Summary; linked: string | null }) {
  const [index, setIndex] = useState<IssueSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [filter, setFilter] = useState("");
  const [repo, setRepo] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("");

  useEffect(() => {
    getJSON<IssueSummary[]>("data/issues/index.json").then(setIndex, () => setError(true));
  }, []);

  const shown = useMemo(() => {
    if (!index) return [];
    const f = filter.toLowerCase();
    return index.filter((it) => (!repo || it.repo === repo) && (!f || it.id.includes(f) || it.title.toLowerCase().includes(f)) && (!outcome || it[outcome]));
  }, [index, filter, repo, outcome]);

  const select = (id: string) => {
    setSelected(id);
    setBrowsing(false);
    replaceHash(href("explore", id));
    document.getElementById("explorer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const random = () => {
    const pool = shown.length ? shown : index ?? [];
    if (pool.length) select(pool[Math.floor(Math.random() * pool.length)].id);
  };

  // A linked issue (#/explore/<id>), else one that shows the pipeline at work.
  useEffect(() => {
    if (!index) return;
    if (linked && index.some((i) => i.id === linked)) setSelected(linked);
    else if (!selected) setSelected((index.find((i) => i.rescued && i.first) ?? index[0]).id);
  }, [index, linked]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    loadIssue(selected).then((it) => live && setIssue(it), () => live && setError(true));
    return () => {
      live = false;
    };
  }, [selected]);

  const repos = useMemo(() => [...new Set((index ?? []).map((i) => i.repo))].sort(), [index]);
  const current = index?.find((i) => i.id === selected);

  return (
    <div class="explorer" id="explorer">
      <div class="picker frame">
        <div class="picker-now">
          <span class="muted small">Looking at</span>
          <b>{current ? `a ${project(current.repo)} bug` : "…"}</b>
          <span class="muted small">{index ? ` · one of ${index.length} real bugs` : ""}</span>
        </div>
        <div class="picker-actions">
          <button type="button" class="btn small" onClick={random} disabled={!index}>Random bug</button>
          <button type="button" class="btn small" aria-expanded={browsing} aria-controls="bug-browser" onClick={() => setBrowsing(!browsing)}>
            {browsing ? "Close the list" : `Browse all ${index?.length ?? ""} bugs`}
          </button>
        </div>
      </div>

      {browsing && (
        <div class="bug-browser" id="bug-browser">
          <div class="bug-filters">
            <input type="search" placeholder="Search bug titles…" aria-label="Search bug titles" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
            <select aria-label="Project" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
              <option value="">Every project</option>
              {repos.map((r) => <option key={r} value={r}>{project(r)}</option>)}
            </select>
          </div>
          <div class="chips" role="group" aria-label="Outcome">
            {OUTCOMES.map(([v, label]) => (
              <button key={v} type="button" class={`chip${outcome === v ? " accent" : ""}`} aria-pressed={outcome === v} onClick={() => setOutcome(v)}>{label}</button>
            ))}
            <span class="issue-count">{shown.length} shown</span>
          </div>
          <ul class="bug-grid">
            {shown.map((it) => <BugCard key={it.id} it={it} on={it.id === selected} onPick={() => select(it.id)} />)}
          </ul>
        </div>
      )}

      <div aria-live="polite">
        {error && <p class="muted">Could not load the bug data.</p>}
        {!issue && !error && <p class="muted">Loading bugs…</p>}
        {issue && <IssueView issue={issue} summary={summary} onNext={random} />}
      </div>
    </div>
  );
}
