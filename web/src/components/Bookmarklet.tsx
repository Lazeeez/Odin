/**
 * "Odin this": a bookmarklet for the bookmarks bar. On a GitHub repository, issue or pull request
 * page it opens Odin with that repository loaded and the issue as the query.
 */
export function Bookmarklet() {
  // The site's own address, absolute: BASE_URL is relative ("./"), so resolve it against this page.
  const site = new URL(import.meta.env.BASE_URL, `${location.origin}${location.pathname}`).href;
  // Plain string handling, no regex: nothing in it needs escaping twice (TypeScript, then URL).
  const script =
    "(()=>{const p=location.pathname.split('/');" +
    "if(location.hostname!=='github.com'||!p[1]||!p[2]){alert('Open a GitHub repository or issue first.');return}" +
    "const n=(p[3]==='issues'||p[3]==='pull')&&+p[4]>0?'&issue='+p[4]:'';" +
    `open('${site}#/search?repo='+p[1]+'/'+p[2]+n)})()`;
  // Percent-encoded: a raw "#" (as in #/search) would end the URL there when saved as a
  // bookmark, cutting the script short. Browsers decode a javascript: URL before running it.
  const code = `javascript:${encodeURIComponent(script)}`;
  return (
    <div class="bookmarklet frame">
      <a class="bookmarklet-btn" href={code} onClick={(e) => e.preventDefault()} title="Drag me to your bookmarks bar">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z" /></svg>Odin this
      </a>
      <div>
        <b>Drag “Odin this” to your bookmarks bar.</b>
        <p>
          On any GitHub issue, click it: Odin opens with the repository loading and the issue's title and body as the query. It reads
          the page's URL only (<code>owner/repo/issues/N</code>); the issue text comes from GitHub's public API.
        </p>
      </div>
    </div>
  );
}
