import { useEffect, useState } from "preact/hooks";
import { load, save } from "../lib/storage.ts";

export const REPO_URL = "https://github.com/Lazeeez/Odin";

type Theme = "system" | "dark" | "light";
const ORDER: Theme[] = ["system", "dark", "light"];
const ICON: Record<Theme, string> = { system: "◐", dark: "☾", light: "☀" };

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => load<Theme>("theme", "system"));
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    save("theme", theme === "system" ? undefined : theme);
  }, [theme]);
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  return (
    <button class="theme" type="button" onClick={() => setTheme(next)} title={`Theme: ${theme} (switch to ${next})`} aria-label={`Colour theme: ${theme}. Switch to ${next}.`}>
      {ICON[theme]}
    </button>
  );
}

export function Nav() {
  return (
    <header class="nav">
      <a class="brand" href="#top">Odin</a>
      <nav>
        <a href="#pipeline">Pipeline</a>
        <a href="#results">Results</a>
        <a href="#try">Try it</a>
        <a href="#explorer">Explorer</a>
        <a href="#engineering">Engineering</a>
        <ThemeToggle />
        <a class="gh" href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
      </nav>
    </header>
  );
}
