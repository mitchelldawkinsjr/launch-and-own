// SEO and redirects turn-on (owner decision 2026-11-26): ADD new files only, never edit an existing page.
// SEO adds public/robots.txt and public/sitemap.xml (built from the site's own HTML pages);
// SEO keeps existing files and proposes only missing ones. Redirects add public/_redirects.
const PATH = /^\/[A-Za-z0-9._~\/-]*$/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
const MAX_URLS = 1000;
const ROBOTS = 'public/robots.txt', SITEMAP = 'public/sitemap.xml';
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function route(path) {
  const rel = path.slice('public/'.length);
  if (rel.split('/').some(seg => seg.startsWith('.') || seg === '')) return null;
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  if (rel === '404.html') return null;
  return '/' + rel.slice(0, -'.html'.length);
}

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function buildSiteFilesProposal({kind, payload, paths, origin} = {}) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) return {ok: false, reason: 'tree_unreadable'};
  const existing = new Map(paths.map(path => [path.toLowerCase(), path]));
  const files = [];
  let existingFiles;
  if (kind === 'seo') {
    const robots = existing.get(ROBOTS);
    const sitemap = existing.get(SITEMAP);
    existingFiles = [robots, sitemap].filter(Boolean);
    if (robots && sitemap) return {ok: false, reason: 'already_present', existingFiles};
    if (!ORIGIN.test(origin || '')) return {ok: false, reason: 'origin_unverified'};
    if (!robots) files.push({path: ROBOTS, content: 'User-agent: *\nAllow: /\nSitemap: ' +
      origin + '/' + (sitemap || SITEMAP).slice('public/'.length) + '\n'});
    if (!sitemap) {
      const routes = paths.filter(p => p.startsWith('public/') && p.toLowerCase().endsWith('.html'))
        .map(route).filter(Boolean).sort();
      if (!routes.length) return {ok: false, reason: 'no_pages'};
      if (routes.length > MAX_URLS) return {ok: false, reason: 'too_many_pages'};
      files.push({path: SITEMAP, content: '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        routes.map(r => '  <url><loc>' + xml(origin + encodeURI(r)) + '</loc></url>').join('\n') + '\n</urlset>\n'});
    }
  } else if (kind === 'redirects') {
    // Apex/www redirects need DNS changes; only same-site path redirects are file-based.
    if (payload?.wwwMode !== 'none') return {ok: false, reason: 'www_redirect_unsupported'};
    const rules = Array.isArray(payload?.pathRules) ? payload.pathRules : [];
    if (!rules.length) return {ok: false, reason: 'no_rules'};
    if (rules.some(r => !PATH.test(r?.from || '') || !PATH.test(r?.to || '') || r.from === r.to ||
        r.from.includes('//') || r.to.includes('//')))
      return {ok: false, reason: 'unsafe_rule'};
    files.push({path: 'public/_redirects', content: rules.map(r => r.from + ' ' + r.to + ' 301').join('\n') + '\n'});
  } else return {ok: false, reason: 'unsupported_kind'};
  if (files.some(f => existing.has(f.path.toLowerCase()))) return {ok: false, reason: 'file_exists'};
  return {ok: true, files, ...(existingFiles?.length ? {existingFiles} : {}),
    digest: await sha256(JSON.stringify(['launch-and-own-site-files-v1', kind, files]))};
}
