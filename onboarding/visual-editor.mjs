/** CSP-safe visual editor shell: live preview iframe + inventory-backed target list (no scripts). */
import { escape } from './ui.mjs';

export const VISUAL_EDITOR_CSS = `
.ve-wrap{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(280px,0.85fr);gap:16px;align-items:start}
@media(max-width:900px){.ve-wrap{grid-template-columns:1fr}}
.ve-preview{border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;background:#fff;min-height:320px}
.ve-preview iframe{display:block;width:100%;min-height:min(70vh,640px);border:0;background:#fff}
.ve-panel{display:grid;gap:12px}
.ve-targets{list-style:none;margin:0;padding:0;display:grid;gap:6px;max-height:min(50vh,420px);overflow:auto}
.ve-targets a{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r);text-decoration:none;color:var(--ink);background:#fff}
.ve-targets a:hover,.ve-targets a[aria-current="true"]{border-color:var(--blue);background:var(--blue-soft)}
.ve-targets .ve-kind{font-size:.72rem;font-weight:700;color:var(--blue-deep);text-transform:uppercase;letter-spacing:.06em}
.ve-fallback{margin-top:16px;border-top:1px solid var(--line);padding-top:14px}
`;

const KIND_OPTIONS = [
  ['text', 'Unique visible text'],
  ['link', 'Unique link address'],
  ['business_info', 'Unique business email or phone'],
  ['css_color', 'Existing CSS custom property color']
];

/** Build /prefix/encoded/path?query for same-origin asset resolution inside the iframe. */
export function livePreviewUrl(prefix, page, query) {
  if (typeof prefix !== 'string' || typeof page !== 'string' || typeof query !== 'string') throw new TypeError('live preview url shape');
  if (page.includes('..') || page.includes('\\') || page.startsWith('/')) throw new TypeError('live preview page');
  const path = page.split('/').map(part => encodeURIComponent(part)).join('/');
  const join = query ? (query.startsWith('?') ? query : '?' + query) : '';
  return prefix + path + join;
}

export function visualEditorMarkup({
  jobId, page, pages, iframeSrc, targets, picked, csrf, previewAction, editorPath, aiBlock = '', notes = ''
} = {}) {
  if (!pages?.length || !Array.isArray(targets) || typeof jobId !== 'string' || typeof page !== 'string' || typeof iframeSrc !== 'string') {
    throw new TypeError('visual editor shape');
  }
  const editorBase = editorPath.split('?')[0] || editorPath;

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

  const advanced = '<details class="ve-fallback"><summary>Advanced: type the exact text</summary>' +
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

  return (notes ? notes : '') +
    '<p>Click something you can change, update it, and preview before you approve. Your live site stays unchanged until you publish.</p>' +
    '<form class="ve-page" method="GET" action="' + escape(editorBase) + '">' +
    '<input type="hidden" name="id" value="' + escape(jobId) + '">' +
    '<label for="ve-page">Page</label><select id="ve-page" name="page">' + pageOptions + '</select> ' +
    '<button type="submit" class="btn-secondary">Show this page</button></form>' +
    '<div class="ve-wrap">' +
    '<div class="ve-preview"><iframe title="Current site preview (read-only)" src="' + escape(iframeSrc) + '" loading="lazy" sandbox="allow-same-origin"></iframe>' +
    '<p class="muted">Scripts are blocked. This is the current version from GitHub, not your live edit yet.</p></div>' +
    '<div class="ve-panel">' + targetList + pickedForm + '</div></div>' +
    aiBlock + advanced;
}