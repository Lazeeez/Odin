// Hash routes (#/search?repo=...): GitHub Pages serves one static file, so the path after "#"
// is the page. Tiny on purpose: five pages do not need a routing library.
import { useEffect, useMemo, useState } from "preact/hooks";

export type Page = "home" | "search" | "benchmarks" | "explore" | "how" | "case";

export interface Route {
  page: Page;
  /** The segment after the page, e.g. the issue id in #/explore/<id>. */
  param: string | null;
  query: URLSearchParams;
}

const PATHS: Record<Page, string> = { home: "", search: "search", benchmarks: "benchmarks", explore: "explore", how: "how-it-works", case: "case-study" };
const PAGES = Object.fromEntries(Object.entries(PATHS).map(([page, path]) => [path, page])) as Record<string, Page>;

export function parseHash(hash: string): Route {
  const [path, qs = ""] = hash.replace(/^#\/?/, "").split("?");
  const [first = "", ...rest] = path.split("/");
  return { page: PAGES[first] ?? "home", param: rest.length ? decodeURIComponent(rest.join("/")) : null, query: new URLSearchParams(qs) };
}

/** The href for a page: `href("explore", id)`, `href("search", null, { repo })`. */
export function href(page: Page, param?: string | null, query?: Record<string, string | undefined>): string {
  let h = `#/${PATHS[page]}`;
  if (param) h += `/${encodeURIComponent(param)}`;
  const qs = new URLSearchParams(Object.entries(query ?? {}).filter((e): e is [string, string] => !!e[1])).toString();
  return qs ? `${h}?${qs}` : h;
}

/** Update the address bar without a navigation (state a page already shows, e.g. the query). */
export function replaceHash(hash: string): void {
  if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${hash}`);
}

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => {
      upgradeLegacyUrl(); // an old-style link can also arrive as a hash change in an open tab
      setHash(location.hash);
    };
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}

/**
 * Links shared before the site had pages: ?repo=&q= searches, #issue=<id> explorer views and
 * the old section anchors. Rewritten once, before the first render.
 */
export function upgradeLegacyUrl(): void {
  const search = new URLSearchParams(location.search);
  const old = location.hash;
  let next: string | null = null;
  if (search.get("repo")) next = href("search", null, { repo: search.get("repo")!, q: search.get("q") ?? undefined });
  else if (old.startsWith("#issue=")) next = href("explore", decodeURIComponent(old.slice(7)));
  else {
    const anchors: Record<string, Page> = { "#try": "search", "#explorer": "explore", "#results": "benchmarks", "#pipeline": "how", "#engineering": "how", "#top": "home" };
    if (anchors[old]) next = href(anchors[old]);
  }
  if (next) history.replaceState(null, "", `${location.pathname}${next}`);
}
