import { type RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Adds `in` to every `.reveal` under `root` the first time it scrolls into view, including ones
 * rendered later (sections that wait for data), which a MutationObserver hands to the observer.
 */
export function useReveal(root: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const pending = () => el.querySelectorAll<HTMLElement>(".reveal:not(.in)");
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      const show = () => pending().forEach((r) => r.classList.add("in"));
      show();
      const mo = new MutationObserver(show);
      mo.observe(el, { childList: true, subtree: true });
      return () => mo.disconnect();
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.05 },
    );
    const watched = new WeakSet<Element>();
    const watch = () => pending().forEach((r) => {
      if (!watched.has(r)) {
        watched.add(r);
        io.observe(r);
      }
    });
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [root]);
}

/** Counts from 0 to `value` once `el` is in view, easing out; the final value at once without motion. */
export function useCountUp(value: number | null, el: RefObject<HTMLElement>, ms = 1400): number | null {
  const [shown, setShown] = useState<number | null>(value == null ? null : 0);
  useEffect(() => {
    if (value == null) return setShown(null);
    setShown(0);
    if (reducedMotion() || !el.current || !("IntersectionObserver" in window)) return setShown(value);
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        setShown(value * (1 - (1 - k) ** 3));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    io.observe(el.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, el, ms]);
  return shown;
}
