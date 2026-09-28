import { useEffect, useState } from "preact/hooks";

/** Loads a module the first time `when` is true, so features nobody opens cost no download. */
export function useLazy<T>(load: () => Promise<T>, when: boolean): T | null {
  const [mod, setMod] = useState<T | null>(null);
  useEffect(() => {
    if (when && !mod) load().then(setMod, () => {});
  }, [when]);
  return mod;
}
