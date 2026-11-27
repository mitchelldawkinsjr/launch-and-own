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
  const siteSlug = params.get('slug') || '';
  const pageUrl = mirrorBase + page.split('/').map(encodeURIComponent).join('/');
  const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/') + 1) : '';
  const baseHref = location.origin + mirrorBase + dir.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir ? '/' : '');
  const liveSiteUrl = siteSlug && /^[a-z0-9-]{1,40}$/.test(siteSlug)
    ? ('https://esp-' + siteSlug + '-site.pages.dev' + (
      page === 'index.html' ? '/'
        : page.endsWith('/index.html') ? '/' + page.slice(0, -'index.html'.length)
          : '/' + page.split('/').map(encodeURIComponent).join('/')
    ))
    : '';

  // Keep local-folder tools hidden. Preview (eye) runs page JS in a sandboxed viewer.
  const HIDE = [
    'tb-open', 'tb-open-folder', 'tb-import', 'tb-refresh', 'tb-diff', 'tb-export',
    'empty-open-local', 'empty-open-folder', 'empty-import', 'empty-new', 'site-open-folder'
  ];

  let scriptView = null;
  let scriptViewBusy = false;

  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'error');
    t.textContent = msg;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  function clearDirty() {
    if (window.EditorState && typeof window.EditorState.setDirty === 'function') {
      window.EditorState.setDirty(false);
    } else if (window.EditorState?.state) {
      window.EditorState.state.dirty = false;
    }
  }

  function injectHostBase(html) {
    if (/<base\b/i.test(html)) return html;
    const tag = '<base id="__he_base__" href="' + baseHref + '">';
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + tag) : tag + html;
  }

  // Edit canvas has no allow-scripts. Hold page scripts/handlers so doc.write
  // does not spam the console; restore them before Preview/save serialization.
  function holdScriptsForCanvas(html) {
    return String(html)
      .replace(/<script\b([^>]*)>/gi, (_, attrs) => {
        let next = attrs;
        if (/\btype\s*=/i.test(next)) {
          next = next.replace(/\btype\s*=\s*(["'][^"']*["']|[^\s>]+)/i, 'type="text/lo-held"');
        } else {
          next += ' type="text/lo-held"';
        }
        if (!/\bdata-lo-script\s*=/i.test(next)) next += ' data-lo-script="1"';
        return '<script' + next + '>';
      })
      .replace(/\s(on[a-z]+)\s*=\s*(["'])/gi, ' data-lo-$1=$2');
  }

  function releaseScriptsFromHtml(html) {
    return String(html)
      .replace(/<script\b([^>]*)>/gi, (full, attrs) => {
        if (!/\bdata-lo-script\s*=/i.test(attrs)) return full;
        let next = attrs.replace(/\s*data-lo-script\s*=\s*(["']?)1\1/i, '');
        next = next.replace(/\s*\btype\s*=\s*(["']?)text\/lo-held\1/i, '');
        return '<script' + next + '>';
      })
      .replace(/\sdata-lo-(on[a-z]+)\s*=\s*(["'])/gi, ' $1=$2');
  }

  function isMirrorUrl(url) {
    try {
      const parsed = new URL(url, baseHref);
      const prefix = mirrorBase.startsWith('/') ? mirrorBase : '/' + mirrorBase;
      return parsed.origin === location.origin && parsed.pathname.startsWith(prefix);
    } catch {
      return false;
    }
  }

  function resolveAssetUrl(href) {
    try {
      return new URL(href, baseHref).href;
    } catch {
      return null;
    }
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  }

  // Build a self-contained page for the sandboxed viewer: parent fetches the
  // owner's mirror files (known domain / repo paths) with the session cookie,
  // then inlines them so the viewer can run scripts without sharing that session.
  async function buildScriptedPreviewHtml() {
    const raw = injectHostBase(window.FileOps.currentHtml());
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.id = '__he_base__';
      base.href = baseHref;
      (doc.head || doc.documentElement).prepend(base);
    }

    for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
      const url = resolveAssetUrl(link.getAttribute('href'));
      if (!url || !isMirrorUrl(url)) continue;
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) continue;
        const style = doc.createElement('style');
        style.setAttribute('data-lo-inlined', link.getAttribute('href') || '');
        style.textContent = await replaceCssUrls(await response.text());
        link.replaceWith(style);
      } catch (_) {}
    }

    for (const script of [...doc.querySelectorAll('script[src]')]) {
      const type = (script.getAttribute('type') || 'text/javascript').toLowerCase();
      if (type === 'module' || (type && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'text/ecmascript')) continue;
      const url = resolveAssetUrl(script.getAttribute('src'));
      if (!url) continue;
      if (!isMirrorUrl(url)) continue; // leave CDN scripts as src — they load without our cookies
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) continue;
        const code = await response.text();
        script.removeAttribute('src');
        script.textContent = code.replace(/<\/(script)/gi, '<\\/$1');
      } catch (_) {}
    }

    for (const el of [...doc.querySelectorAll('img[src], source[src], video[src], audio[src]')]) {
      const src = el.getAttribute('src');
      if (!src || src.startsWith('data:')) continue;
      const url = resolveAssetUrl(src);
      if (!url || !isMirrorUrl(url)) continue;
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) continue;
        el.setAttribute('src', await blobToDataUrl(await response.blob()));
      } catch (_) {}
    }

    for (const el of [...doc.querySelectorAll('[style*="url("]')]) {
      const style = el.getAttribute('style') || '';
      const next = await replaceCssUrls(style);
      if (next !== style) el.setAttribute('style', next);
    }

    let html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    return html.replace(/<\/(script)/gi, '<\\/$1');
  }

  async function replaceCssUrls(css) {
    const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
    const parts = [];
    let last = 0;
    let match;
    while ((match = re.exec(css))) {
      parts.push(css.slice(last, match.index));
      const raw = match[2].trim();
      last = match.index + match[0].length;
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) {
        parts.push(match[0]);
        continue;
      }
      const url = resolveAssetUrl(raw);
      if (!url || !isMirrorUrl(url)) {
        parts.push(match[0]);
        continue;
      }
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
          parts.push(match[0]);
          continue;
        }
        parts.push('url("' + await blobToDataUrl(await response.blob()) + '")');
      } catch (_) {
        parts.push(match[0]);
      }
    }
    parts.push(css.slice(last));
    return parts.join('');
  }

  function ensureScriptView() {
    if (scriptView) return scriptView;
    const frame = document.querySelector('.canvas-frame');
    const canvas = document.getElementById('canvas');
    if (!frame || !canvas) return null;
    scriptView = document.createElement('iframe');
    scriptView.id = 'lo-script-view';
    scriptView.title = 'Live site preview with scripts';
    // pages.dev is a different origin than Launch & Own, so allow-same-origin is safe here:
    // scripts get a real site origin, but still cannot read the editor session.
    scriptView.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
    scriptView.setAttribute('referrerpolicy', 'no-referrer');
    scriptView.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;z-index:6';
    frame.appendChild(scriptView);
    return scriptView;
  }

  async function showScriptedPreview() {
    const view = ensureScriptView();
    const canvas = document.getElementById('canvas');
    if (!view || !canvas || scriptViewBusy) return;
    // srcdoc/blob inherit the editor CSP and blank the page. Load the known
    // pages.dev origin instead so fonts, images, and scripts use the site's own policy.
    if (!liveSiteUrl) {
      toast('Live scripted preview needs your pages.dev site. Use the external-link control after publish.', 'error');
      return;
    }
    scriptViewBusy = true;
    try {
      view.hidden = false;
      canvas.style.visibility = 'hidden';
      view.removeAttribute('srcdoc');
      view.src = liveSiteUrl;
    } finally {
      scriptViewBusy = false;
    }
  }

  function hideScriptedPreview() {
    const canvas = document.getElementById('canvas');
    if (scriptView) {
      scriptView.hidden = true;
      scriptView.removeAttribute('srcdoc');
      scriptView.src = 'about:blank';
    }
    if (canvas) canvas.style.visibility = '';
  }

  // Turn embedded images still referenced by the page into images/lo-N.ext files.
  // Only src= / url() data URIs count — removed images must not become PR files.
  function packImages(html) {
    const images = [];
    let n = 0;
    const dataUri = /data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/i;
    const next = String(html).replace(
      /(\bsrc\s*=\s*(["'])|url\(\s*(["']?))(data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+)(\2|\3)?(\))?/gi,
      (all, prefix, q1, q2, uri, closeQuote, closeParen) => {
        const match = dataUri.exec(uri);
        if (!match) return all;
        n += 1;
        if (n > 8) return all;
        const name = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
        const path = 'images/lo-' + n + '.' + name;
        images.push({ path, base64: match[2] });
        if (prefix.toLowerCase().startsWith('url')) {
          const quote = q2 || '';
          return 'url(' + quote + path + quote + (closeParen || ')');
        }
        const quote = q1 || '"';
        return 'src=' + quote + path + quote;
      }
    );
    if (n > 8) throw new Error('At most 8 new images can be previewed at once.');
    // Drop any packed file the HTML no longer references (add-then-remove).
    const kept = images.filter(image => next.includes(image.path));
    return { html: next, images: kept };
  }

  function errorMessageFromBody(text) {
    const paragraph = text.match(/<p>([^<]+)<\/p>/i);
    const title = text.match(/<title>([^|<]+)/i);
    return (paragraph?.[1] || title?.[1] || '')
      .replace(/\s+/g, ' ').trim().slice(0, 240)
      || text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
      || 'Preview was refused.';
  }

  function showLeavingOverlay() {
    let overlay = document.getElementById('lo-preview-leaving');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lo-preview-leaving';
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');
      overlay.innerHTML = '<div class="lo-preview-leaving-card"><div class="lo-preview-leaving-spin" aria-hidden="true"></div>' +
        '<p><strong>Preparing your preview</strong></p><p>Taking you to the review page…</p></div>';
      const style = document.createElement('style');
      style.textContent = '#lo-preview-leaving{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;' +
        'background:rgba(10,10,10,.72);color:#f4f4f5;font:15px/1.4 system-ui,sans-serif}' +
        '.lo-preview-leaving-card{display:grid;gap:10px;justify-items:center;text-align:center;padding:28px 32px;' +
        'border-radius:16px;background:#16161a;border:1px solid #2a2a30;max-width:22rem}' +
        '.lo-preview-leaving-card p{margin:0}.lo-preview-leaving-card strong{font-size:1.05rem}' +
        '.lo-preview-leaving-spin{width:36px;height:36px;border-radius:50%;border:3px solid #3f3f46;' +
        'border-top-color:#f4f4f5;animation:lo-spin .8s linear infinite}' +
        '@keyframes lo-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
      document.body.appendChild(overlay);
    }
    overlay.hidden = false;
  }

  function hideLeavingOverlay() {
    const overlay = document.getElementById('lo-preview-leaving');
    if (overlay) overlay.hidden = true;
  }

  function goToReview(url) {
    clearDirty();
    showLeavingOverlay();
    (window.top || window).location.href = url;
  }

  async function previewSave() {
    const status = document.getElementById('save-status');
    try {
      if (!csrf) throw new Error('Reload the editor from your launches page.');
      const packed = packImages(window.FileOps.currentHtml());
      if (packed.html.length > 1_500_000) throw new Error('This page is too large to preview in one save.');
      if (status) { status.dataset.state = 'saving'; status.textContent = 'Previewing…'; }
      clearDirty();
      showLeavingOverlay();

      const response = await fetch(savePath, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csrf, id, page, html: packed.html, images: packed.images })
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Preview succeeded but no review link was returned.');
        goToReview(location);
        return;
      }
      if (response.type === 'opaqueredirect') {
        // Some browsers hide manual redirects; fall back to a top-level form POST.
        submitPreviewForm(packed);
        return;
      }
      const text = await response.text();
      throw new Error(errorMessageFromBody(text));
    } catch (error) {
      hideLeavingOverlay();
      if (status) { status.dataset.state = 'error'; status.textContent = 'Not previewed'; }
      const message = error && error.message === 'Failed to fetch'
        ? 'Could not reach Preview. Check your connection, hard-refresh, and try again.'
        : (error.message || 'Preview failed');
      toast(message, 'error');
    }
  }

  function submitPreviewForm(packed) {
    clearDirty();
    showLeavingOverlay();
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = savePath;
    form.target = '_top';
    form.enctype = 'multipart/form-data';
    form.hidden = true;
    const fields = {
      csrf, id, page,
      html: packed.html,
      images: JSON.stringify(packed.images)
    };
    Object.keys(fields).forEach(name => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = fields[name];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    // Hosted mode does not use site-folder interception; keep Preview off the SW path.
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.resolve({ unregister() { return Promise.resolve(true); } });
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(reg => reg.unregister())).catch(() => {});
    }
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
      save.title = 'Preview for approval. Publishing happens on the next screen when you Approve and publish.';
    }
    const eye = document.getElementById('tb-preview');
    if (eye) {
      eye.title = 'View this page with its JavaScript running (sandboxed). Click again to return to editing.';
    }
    const git = document.getElementById('tb-git-diff');
    if (git) git.disabled = false;
    const external = document.getElementById('tb-external-preview');
    if (external) {
      external.hidden = false;
      external.title = liveSiteUrl
        ? 'Open your live pages.dev site in a new tab (scripts run on your site’s domain).'
        : 'Open a sandboxed tab with this page’s scripts running.';
      external.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (liveSiteUrl) {
          window.open(liveSiteUrl, '_blank', 'noopener,noreferrer');
          return;
        }
        try {
          const html = await buildScriptedPreviewHtml();
          // data: URLs are opaque-origin — unlike blob: URLs they do not inherit the editor session.
          const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
          toast(error.message || 'Could not open scripted preview.', 'error');
        }
      }, true);
    }

    const originalInject = window.Site.injectBase.bind(window.Site);
    window.Site.injectBase = html => injectHostBase(originalInject(html));
    const originalLoadHtml = window.Canvas.loadHtml.bind(window.Canvas);
    window.Canvas.loadHtml = html => originalLoadHtml(holdScriptsForCanvas(html));
    const originalCurrentHtml = window.FileOps.currentHtml.bind(window.FileOps);
    window.FileOps.currentHtml = () => releaseScriptsFromHtml(originalCurrentHtml());
    window.FileOps.save = previewSave;
    const originalSetPreview = window.Canvas.setPreview.bind(window.Canvas);
    window.Canvas.setPreview = (on) => {
      originalSetPreview(on);
      if (on) showScriptedPreview();
      else hideScriptedPreview();
    };
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
    // Gallery/menus need the live site's JS — open pages.dev Preview once loaded.
    if (liveSiteUrl) document.getElementById('tb-preview')?.click();
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
