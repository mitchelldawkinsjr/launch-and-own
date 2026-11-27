// Hosted mode for Launch & Own. Active only with ?id= and ?page=.
// Loads the GitHub page from the same-origin mirror, keeps new images in the
// save payload, and posts a preview. It does not write to disk or to GitHub.
(function () {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const page = params.get('page');
  if (!id || !page || page.includes('..') || page.startsWith('/')) return;

  const mirrorKind = params.get('mirror') === 'assistant' ? 'assistant' : 'hosted';
  const savePath = mirrorKind === 'assistant' ? '/visual-preview' : '/imported-edit-visual-preview';
  const mirrorBase = mirrorKind === 'assistant'
    ? '/live/'
    : '/imported-edit-live/' + encodeURIComponent(id) + '/';
  const csrf = decodeURIComponent((location.hash.match(/(?:^#|&)csrf=([^&]*)/) || [])[1] || '');
  const pageUrl = mirrorBase + page.split('/').map(encodeURIComponent).join('/');
  const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/') + 1) : '';
  const baseHref = location.origin + mirrorBase + dir.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir ? '/' : '');

  const HIDE = [
    'tb-open', 'tb-open-folder', 'tb-import', 'tb-refresh', 'tb-diff', 'tb-export', 'tb-external-preview',
    'empty-open-local', 'empty-open-folder', 'empty-import', 'empty-new', 'site-open-folder'
  ];

  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'error');
    t.textContent = msg;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  function injectHostBase(html) {
    if (/<base\b/i.test(html)) return html;
    const tag = '<base id="__he_base__" href="' + baseHref + '">';
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + tag) : tag + html;
  }

  // Turn embedded images into images/lo-N.ext so the preview stores real files.
  function packImages(html) {
    const images = [];
    let n = 0;
    const next = html.replace(/data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/g, (all, ext, data) => {
      n += 1;
      if (n > 8) return all;
      const name = ext === 'jpeg' ? 'jpg' : ext;
      const path = 'images/lo-' + n + '.' + name;
      images.push({ path, base64: data });
      return path;
    });
    if (n > 8) throw new Error('At most 8 new images can be previewed at once.');
    return { html: next, images };
  }

  async function previewSave() {
    const status = document.getElementById('save-status');
    try {
      if (!csrf) throw new Error('Reload the editor from your launches page.');
      const packed = packImages(window.FileOps.currentHtml());
      if (status) { status.dataset.state = 'saving'; status.textContent = 'Previewing…'; }
      const response = await fetch(savePath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csrf, id, page, html: packed.html, images: packed.images })
      });
      if (response.redirected && response.url) {
        (window.top || window).location.href = response.url;
        return;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          (window.top || window).location.href = location;
          return;
        }
      }
      const text = await response.text();
      const paragraph = text.match(/<p>([^<]+)<\/p>/i);
      const title = text.match(/<title>([^|<]+)/i);
      const message = (paragraph?.[1] || title?.[1] || '')
        .replace(/\s+/g, ' ').trim().slice(0, 240)
        || text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
        || 'Preview was refused.';
      throw new Error(message);
    } catch (error) {
      if (status) { status.dataset.state = 'error'; status.textContent = 'Not previewed'; }
      toast(error.message || 'Preview failed', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const hostedCss = document.createElement('style');
    hostedCss.textContent = ':root{--sidebar-w:240px;--sidebar-r-w:280px}' +
      'html,body{height:100%;margin:0;background:#0a0a0a}' +
      '.editor{height:100vh}' +
      '.file-info{display:none}' +
      '.toolbar{overflow-x:auto}' +
      '@media(max-width:820px){.workspace{grid-template-columns:minmax(0,1fr)!important}.left-sidebar,.right-sidebar{display:none}}';
    document.head.appendChild(hostedCss);
    HIDE.forEach(elementId => {
      const el = document.getElementById(elementId);
      if (el) el.hidden = true;
    });
    const save = document.getElementById('tb-save');
    if (save) {
      const label = save.querySelector('span');
      if (label) label.textContent = 'Preview';
      save.title = 'Preview this page for approval. Nothing is published yet.';
    }
    const git = document.getElementById('tb-git-diff');
    if (git) git.disabled = false;

    const originalInject = window.Site.injectBase.bind(window.Site);
    window.Site.injectBase = html => injectHostBase(originalInject(html));
    window.FileOps.save = previewSave;
    window.GitDiff.showDiff = async () => {
      const head = window.__loBaseHtml || '';
      const current = window.FileOps.currentHtml();
      if (head === current) { toast('Editor matches the GitHub copy', 'success'); return; }
      await window.DiffViewer._renderModal(head, current, 'GitHub', 'editor', { hideApplyButtons: true });
    };

    const brand = document.querySelector('.brand-text');
    if (brand) brand.textContent = page;
    const response = await fetch(pageUrl, { credentials: 'same-origin' });
    if (!response.ok) { toast('This page could not be loaded from GitHub.', 'error'); return; }
    const html = await response.text();
    window.__loBaseHtml = html;
    document.getElementById('empty-state').hidden = true;
    document.getElementById('editor').hidden = false;
    await window.ModeSwitch.loadIntoInitialMode(html);
    await showGithubProject();
  });

  function fileButton(path, current) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.textContent = path;
    if (current) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => {
      if (path === page) return;
      const target = new URL(window.top.location.href);
      target.searchParams.set('page', path);
      window.top.location.href = target.toString();
    });
    return button;
  }

  async function showGithubProject() {
    const listUrl = mirrorKind === 'assistant' ? '/files' : '/imported-edit-files?id=' + encodeURIComponent(id);
    const listed = await fetch(listUrl, { credentials: 'same-origin' });
    if (!listed.ok) return;
    const body = await listed.json();
    const files = Array.isArray(body.files) ? body.files : [];
    const box = document.getElementById('site-none');
    if (!box) return;
    box.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'Files on GitHub';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'This is the project already in the repository. The editor opens those files.';
    box.append(title, hint);
    const pages = files.filter(path => /\.html?$/i.test(path));
    const assets = files.filter(path => !/\.html?$/i.test(path));
    const addGroup = (label, paths, clickable) => {
      if (!paths.length) return;
      const heading = document.createElement('h4');
      heading.className = 'site-sub';
      heading.textContent = label;
      const list = document.createElement('div');
      list.className = 'recent-list';
      paths.forEach(path => {
        if (clickable) list.append(fileButton(path, path === page));
        else {
          const row = document.createElement('div');
          row.className = 'recent-item';
          row.textContent = path;
          list.append(row);
        }
      });
      box.append(heading, list);
    };
    addGroup('Pages', pages, true);
    addGroup('CSS and images', assets, false);
    const recent = document.getElementById('recent-list');
    if (recent && recent.closest('.assets-section')) recent.closest('.assets-section').hidden = true;
  }
})();
