import { useEffect, useRef, useState } from "preact/hooks";
import { Footer, Nav } from "./components/Nav.tsx";
import { type Lite, type Summary, getJSON } from "./lib/data.ts";
import { useLazy } from "./lib/lazy.ts";
import { type Page, useRoute } from "./lib/router.ts";
import { Benchmarks } from "./pages/Benchmarks.tsx";
import { Explore } from "./pages/Explore.tsx";
import { Home } from "./pages/Home.tsx";
import { HowItWorks } from "./pages/HowItWorks.tsx";
import { Search } from "./pages/Search.tsx";

const TITLES: Record<Page, string> = {
  home: "Odin: find the code behind any bug report",
  search: "Search a repository · Odin",
  benchmarks: "Benchmarks · Odin",
  explore: "Explore real bugs · Odin",
  how: "How it works · Odin",
};

export function App() {
  const route = useRoute();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lite, setLite] = useState<Lite | null>(null);
  const [failed, setFailed] = useState(false);
  // The search app is created on first visit and then kept (hidden) so a loaded repository
  // survives browsing the other pages.
  const [searchOpened, setSearchOpened] = useState(route.page === "search");
  const first = useRef(true);
  // The command palette loads on first use: Ctrl+K (or Cmd+K), or the nav's button.
  const [palette, setPalette] = useState(false);
  const paletteModule = useLazy(() => import("./components/CommandPalette.tsx"), palette);
  const Palette = paletteModule?.default;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    const open = () => setPalette(true);
    addEventListener("keydown", onKey);
    addEventListener("odin:palette", open);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("odin:palette", open);
    };
  }, []);

  useEffect(() => {
    getJSON<Summary>("data/summary.json").then(setSummary, () => setFailed(true));
    getJSON<Lite>("data/lite.json").then(setLite, () => {});
  }, []);

  useEffect(() => {
    document.title = TITLES[route.page];
    if (route.page === "search") setSearchOpened(true);
    if (!first.current) window.scrollTo({ top: 0 });
    first.current = false;
  }, [route.page]);

  const page = route.page;
  return (
    <>
      <a class="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <Nav page={page} />
      <main id="main" tabIndex={-1} class={`page-${page}`}>
        {page === "home" && <Home summary={summary} lite={lite} />}
        {searchOpened && (
          <div hidden={page !== "search"}>
            <Search active={page === "search"} request={route.query} />
          </div>
        )}
        {page === "benchmarks" && <Benchmarks summary={summary} lite={lite} failed={failed} />}
        {page === "explore" && <Explore summary={summary} linked={route.param} failed={failed} mode={route.query.get("mode")} set={route.query.get("set")} />}
        {page === "how" && <HowItWorks summary={summary} />}
      </main>
      <Footer />
      {palette && Palette && <Palette onClose={() => setPalette(false)} />}
    </>
  );
}
