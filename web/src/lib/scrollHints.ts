const mark = (el: HTMLElement) => {
  const more = el.scrollWidth - el.clientWidth - el.scrollLeft > 4;
  if (more) el.dataset.more = "";
  else delete el.dataset.more;
};

export function scrollHints(): () => void {
  const watched = new WeakSet<HTMLElement>();
  const resize = new ResizeObserver((entries) => entries.forEach((e) => mark(e.target as HTMLElement)));
  const scan = () => {
    document.querySelectorAll<HTMLElement>(".table-wrap").forEach((el) => {
      mark(el);
      if (watched.has(el)) return;
      watched.add(el);
      el.addEventListener("scroll", () => mark(el), { passive: true });
      resize.observe(el);
    });
  };
  const mutations = new MutationObserver(scan);
  mutations.observe(document.body, { childList: true, subtree: true });
  scan();
  return () => {
    mutations.disconnect();
    resize.disconnect();
  };
}
