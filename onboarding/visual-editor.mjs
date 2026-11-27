/** CSP-safe visual editor shell: live preview iframe + inventory-backed target list (no scripts). */
import { escape } from './ui.mjs';

export const VISUAL_EDITOR_CSS = `
body:has(.ve-stage){max-width:none!important}
body:has(.ve-stage) .site-header-inner{max-width:none}
body:has(.ve-stage) .shell{max-width:none;width:100%;padding:12px 16px 16px;display:flex;flex-direction:column;min-height:calc(100vh - 58px)}
body:has(.ve-stage) .site-footer{display:none}
.ve-stage{flex:1;display:flex;flex-direction:column;gap:12px;min-height:0}
.ve-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 20px;align-items:start}
.ve-title{min-width:0}
.ve-repo{margin:0 0 2px;font-size:.8rem;font-weight:650;color:var(--muted);line-height:1.3}
.ve-bar h1{font-size:1.35rem;line-height:1.15;letter-spacing:-.02em;margin:0}
.ve-bar .ve-title>p{margin:4px 0 0;max-width:68ch;font-size:.92rem;line-height:1.4;color:var(--muted)}
.ve-page{display:flex;align-items:center;gap:8px;margin:0}
.ve-page label{margin:0;font-size:.84rem}
.ve-page select{width:auto;min-width:12rem;margin:0}
.ve-page button{margin:0}
.ve-wrap{flex:1;display:flex;min-height:420px}
.ve-ask{padding:0;border:0;background:transparent}
.ve-ask form{margin:0}
.ve-ask h2{margin:0 0 6px;font-size:1rem;line-height:1.2;letter-spacing:-.015em}
.ve-ask-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.ve-ask textarea{width:100%;height:44px;min-height:44px;margin:0;resize:none;padding:10px 12px}
.ve-ask button{margin:0;white-space:nowrap;height:44px}
.ve-ask-note{margin:6px 0 0;font-size:.84rem;line-height:1.4}
.ve-preview{flex:1;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-height:420px;height:auto}
.ve-preview iframe{display:block;width:100%;height:100%;min-height:420px;border:0;background:#fff}
@media(max-width:800px){
  .ve-bar,.ve-ask-row{grid-template-columns:1fr}
  .ve-page{flex-wrap:wrap}
  .ve-page select{flex:1;min-width:0}
}
.ve-panel{display:grid;gap:12px}
.ve-targets{list-style:none;margin:0;padding:0;display:grid;gap:6px;max-height:min(50vh,420px);overflow:auto}
.ve-targets a{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r);text-decoration:none;color:var(--ink);background:#fff}
.ve-targets a:hover,.ve-targets a[aria-current="true"]{border-color:var(--blue);background:var(--blue-soft)}
.ve-targets .ve-kind{font-size:.72rem;font-weight:700;color:var(--blue-deep);text-transform:uppercase;letter-spacing:.06em}
.ve-fallback{margin:0;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;padding:8px 0 0}
.ve-fallback>summary{font-size:.92rem}
body:has(.ve-stage) .shell>p:last-child{margin:0;font-size:.88rem}
`;

const KIND_OPTIONS = [
  ['text', 'Unique visible text'],
  ['link', 'Unique link address'],
  ['business_info', 'Unique business email or phone'],
  ['css_color', 'Existing CSS custom property color']
];

/** Map a repo path under public/ to the path Cloudflare Pages usually serves. */
export function publicSitePath(page) {
  if (typeof page !== 'string' || page.includes('..') || page.startsWith('/')) throw new TypeError('preview page path');
  if (page === 'index.html') return '/';
  if (page.endsWith('/index.html')) return '/' + page.slice(0, -'index.html'.length);
  return '/' + page.split('/').map(encodeURIComponent).join('/');
}

/** Same-origin mirror preview: /prefix/{jobId}/file so CSS and images keep the job id in the path. */
export function livePreviewUrl(prefix, page, { jobId } = {}) {
  if (typeof prefix !== 'string' || typeof page !== 'string') throw new TypeError('live preview url shape');
  if (page.includes('..') || page.includes('\\') || page.startsWith('/')) throw new TypeError('live preview page');
  const path = page.split('/').map(part => encodeURIComponent(part)).join('/');
  if (jobId) return prefix + encodeURIComponent(jobId) + '/' + path;
  return prefix + path;
}

export function pagesDevPreviewUrl(siteSlug, page) {
  if (typeof siteSlug !== 'string' || !/^[a-z0-9-]{1,40}$/.test(siteSlug)) throw new TypeError('site slug');
  return 'https://esp-' + siteSlug + '-site.pages.dev' + publicSitePath(page);
}

/** Sentence box for the customer-owned assistant. The hosted editor shows it only on the local preview. */
export function assistantPromptMarkup({ csrf, action, id } = {}) {
  if (typeof csrf !== 'string' || typeof action !== 'string' || (id != null && typeof id !== 'string')) throw new TypeError('assistant prompt shape');
  return '<form method="post" action="' + escape(action) + '"><input type="hidden" name="csrf" value="' + escape(csrf) + '"><input type="hidden" name="mode" value="ai">' +
    (id ? '<input type="hidden" name="id" value="' + escape(id) + '">' : '') +
    '<h2>Ask your AI assistant</h2><div class="ve-ask-row">' +
    '<label class="lo-sr" for="ve-request">What should change?</label>' +
    '<textarea id="ve-request" name="request" maxlength="1000" rows="1" required placeholder="What should change?"></textarea>' +
    '<button type="submit">Prepare a preview</button></div>' +
    '<p class="ve-ask-note"><small>Uses your own Cloudflare Workers AI allowance. You still see the exact change before anything happens.</small></p></form>';
}

export function visualEditorMarkup({
  jobId, page, pages, iframeSrc, previewView = 'mirror', liveSiteSrc, targets, picked, csrf, previewAction, editorPath, aiBlock = '', notes = '', meta = '', siteSlug = ''
} = {}) {
  if (!pages?.length || !Array.isArray(targets) || typeof jobId !== 'string' || typeof page !== 'string' || typeof iframeSrc !== 'string') {
    throw new TypeError('visual editor shape');
  }
  if (previewView !== 'mirror' && previewView !== 'live') throw new TypeError('visual editor shape');
  if (previewView === 'live' && typeof liveSiteSrc !== 'string') throw new TypeError('visual editor shape');
  if (siteSlug && (typeof siteSlug !== 'string' || !/^[a-z0-9-]{1,40}$/.test(siteSlug))) throw new TypeError('visual editor shape');
  const editorBase = editorPath.split('?')[0] || editorPath;
  const mirror = editorPath.startsWith('/imported-edit') ? 'hosted' : 'assistant';
  const visualSrc = '/site-editor/index.html?id=' + encodeURIComponent(jobId) + '&page=' + encodeURIComponent(page)
    + (mirror === 'assistant' ? '&mirror=assistant' : '')
    + (siteSlug ? '&slug=' + encodeURIComponent(siteSlug) : '')
    + '#csrf=' + encodeURIComponent(csrf);

  const pageOptions = pages.map(p =>
    `<option value="${escape(p)}"${p === page ? ' selected' : ''}>${escape(p)}</option>`).join('');

  const onPage = targets.filter(t => t.relativePath === page);
  const targetList = onPage.length
    ? '<ul class="ve-targets" aria-label="Editable content on this page">' + onPage.map(t => {
      const href = editorBase + '?id=' + encodeURIComponent(jobId) + '&page=' + encodeURIComponent(page) + '&pick=' + encodeURIComponent(t.id);
      const current = picked?.id === t.id ? ' aria-current="true"' : '';
      return '<li><a href="' + escape(href) + '"' + current + '><span class="ve-kind">' + escape(t.kindLabel) + '</span> ' + escape(t.label) + '</a></li>';
    }).join('') + '</ul>'
    : '<p class="muted">No editable spots were found on this page.</p>';

  const pickedForm = picked
    ? '<form action="' + escape(previewAction) + '" method="POST">' +
      '<input type="hidden" name="csrf" value="' + escape(csrf) + '">' +
      '<input type="hidden" name="id" value="' + escape(jobId) + '">' +
      '<input type="hidden" name="kind" value="' + escape(picked.kind) + '">' +
      '<input type="hidden" name="path" value="' + escape(picked.relativePath) + '">' +
      '<input type="hidden" name="old" value="' + escape(picked.find) + '">' +
      '<p><strong>Changing:</strong> <span class="badge">' + escape(picked.kindLabel) + '</span></p>' +
      '<p class="muted"><code>' + escape(picked.find) + '</code></p>' +
      '<label for="ve-replace">Replace with</label>' +
      '<input id="ve-replace" name="replacement" maxlength="500" required>' +
      '<p><button type="submit">Preview this change</button></p></form>'
    : '<p class="muted">Choose something in the list to edit it, or use advanced entry below.</p>';

  const advanced = '<details class="ve-fallback"><summary>Advanced: one exact text change</summary>' +
    targetList + pickedForm +
    '<form action="' + escape(previewAction) + '" method="POST">' +
    '<input type="hidden" name="csrf" value="' + escape(csrf) + '">' +
    '<input type="hidden" name="id" value="' + escape(jobId) + '">' +
    '<label for="ve-kind">Change</label><select id="ve-kind" name="kind">' +
    KIND_OPTIONS.map(([v, l]) => '<option value="' + v + '">' + escape(l) + '</option>').join('') +
    '</select>' +
    '<label for="ve-old">Current text on your site</label><input id="ve-old" name="old" maxlength="500" required>' +
    '<label for="ve-new">Replacement</label><input id="ve-new" name="replacement" maxlength="500" required>' +
    '<details><summary>Same text on more than one page?</summary>' +
    '<label for="ve-path">Page file (optional)</label><input id="ve-path" name="path" maxlength="240" placeholder="contact.html"></details>' +
    '<p><button type="submit">Preview this edit</button></p></form></details>';

  const ask = aiBlock ? '<div class="ve-ask">' + aiBlock + '</div>' : '';
  const metaLine = meta ? '<p class="ve-repo">' + escape(meta) + '</p>' : '';
  return '<div class="ve-stage"><div class="ve-bar"><div class="ve-title">' + metaLine + '<h1>Edit this page</h1>' +
    (notes ? notes : '<p class="muted">Choose Preview in the editor. Nothing is published until you approve.</p>') +
    '</div><form class="ve-page" method="GET" action="' + escape(editorBase) + '">' +
    '<input type="hidden" name="id" value="' + escape(jobId) + '">' +
    '<label for="ve-page">Page</label><select id="ve-page" name="page">' + pageOptions + '</select> ' +
    '<button type="submit" class="btn-secondary">Show this page</button></form></div>' +
    ask +
    '<div class="ve-wrap"><div class="ve-preview"><iframe title="Visual page editor" src="' + escape(visualSrc) + '"></iframe></div></div>' +
    advanced + '</div>';
}