import { useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * A bug report's body, clipped to a few lines with a fade. "Read the whole report" appears when
 * the text actually overflows, however it got long: many short lines clip as much as one long one.
 */
export function Report({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    setFull(false);
  }, [text]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !full) setClipped(el.scrollHeight > el.clientHeight + 2);
  }, [text, full]);
  return (
    <>
      <div ref={box} class={`bug-body${full ? " full" : clipped ? "" : " fits"}`}>{text}</div>
      {(clipped || full) && (
        <button type="button" class="link-btn" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? "Show less" : "Read the whole report"}
        </button>
      )}
    </>
  );
}
