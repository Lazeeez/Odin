import { type RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

/** True once the element has come within `margin` of the viewport (and stays true). */
export function useInView(ref: RefObject<Element>, margin = "300px", enabled = true): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || seen || !el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        obs.disconnect();
      }
    }, { rootMargin: margin });
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref, margin, enabled, seen]);
  return seen;
}
