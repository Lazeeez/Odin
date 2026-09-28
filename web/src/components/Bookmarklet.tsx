/**
 * "Odin this": a bookmarklet for the bookmarks bar. On a GitHub repository, issue or pull request
 * page it opens Odin with that repository loaded and the issue as the query.
 */
export function Bookmarklet() {
  const site = `${location.origin}${import.meta.env.BASE_URL}`;
  const code =
    "javascript:(()=>{const m=location.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/(?:issues|pull)\/(\d+))?/);" +
    "if(location.hostname!=='github.com'||!m){alert('Open a GitHub repository or issue first.');return}" +
    `open('${site}#/search?repo='+m[1]+'/'+m[2]+(m[3]?'&issue='+m[3]:''))})()`;
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
