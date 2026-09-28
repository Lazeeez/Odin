import type { ComponentChildren } from "preact";
import { RuneRing } from "./Myth.tsx";

/**
 * The inner pages' header: kicker, a title that resolves word by word, a lede, and a small rune
 * ring turning to one side. Decoration is CSS only.
 */
export function PageHero({ kicker, title, children }: { kicker: string; title: string; children?: ComponentChildren }) {
  const words = title.split(" ");
  return (
    <header class="page-hero">
      <div class="page-hero-sky" aria-hidden="true"><div class="stars" /><RuneRing /></div>
      <p class="kicker intro" style={{ "--d": ".05s" }}>{kicker}</p>
      <h1 aria-label={title}>
        {words.map((w, i) => <span key={i} class="word" aria-hidden="true" style={{ "--i": i }}>{w}{i < words.length - 1 ? " " : ""}</span>)}
      </h1>
      {children && <div class="page-hero-lede intro soft" style={{ "--d": ".25s" }}>{children}</div>}
    </header>
  );
}
