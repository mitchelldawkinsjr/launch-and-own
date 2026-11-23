// Issue #88 / GPT-6. Code-only SEO proposal: never writes files or changes approvals.
// Trusted identity and domain evidence must come from a server-side provider verifier.
import { renderSite, normalizeSite } from './render-site.mjs';
import { renderSiteBundle } from './render-site-bundle.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const SHA = /^[a-f0-9]{40}$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,57}$/;
const SITE_TYPES = new Set(['generated-one-page', 'generated-multi-page']);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const xml = esc;
function hash(s) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
    .then(bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''));
}
function validId(v) { return Number.isSafeInteger(v) && v > 0; }
function deny(status, reason) {
  return Object.freeze({status, reason, files: Object.freeze([]), proposalSha256: null,
    canonicalOrigin: null, publicationVerified: false});
}
function validTrustedSite(site) {
  return site && validId(site.githubUserId) && validId(site.githubRepositoryId) &&
    typeof site.cloudflareAccountId === 'string' && ACCOUNT.test(site.cloudflareAccountId) &&
    typeof site.pagesProjectId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(site.pagesProjectId) &&
    PROJECT.test(site.pagesProjectName || '') && SHA.test(site.expectedBaseSha || '') &&
    site.branch === 'main';
}
function canonicalOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 253) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash ||
        host.length > 253 || !host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host) ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i.test(host) ||
        host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')))
      return null;
    return url.origin;
  } catch { return null; }
}
function evidenceMatches(site, evidence) {
  if (!evidence || typeof evidence !== 'object' || evidence.kind !== 'verified-owned-domain' ||
      evidence.githubUserId !== site.githubUserId ||
      evidence.githubRepositoryId !== site.githubRepositoryId ||
      evidence.cloudflareAccountId !== site.cloudflareAccountId ||
      evidence.pagesProjectId !== site.pagesProjectId ||
      evidence.pagesProjectName !== site.pagesProjectName ||
      evidence.sourceSha !== site.expectedBaseSha ||
      !Number.isSafeInteger(evidence.checkedAt) ||
      !Number.isSafeInteger(evidence.expiresAt)) return false;
  const now = Math.floor(Date.now() / 1000);
  return evidence.checkedAt <= now && evidence.expiresAt > now &&
    evidence.expiresAt - evidence.checkedAt <= 86400 &&
    Boolean(canonicalOrigin(evidence.origin));
}
function headInfo(html) {
  const title = /<title>([^<]{1,200})<\/title>/i.exec(html)?.[1];
  const desc = /<meta name="description" content="([^"]{1,300})">/i.exec(html)?.[1];
  if (!title || !desc || (html.match(/<title>/gi) || []).length !== 1 ||
      (html.match(/<meta name="description"/gi) || []).length !== 1 ||
      (html.match(/<\/head>/gi) || []).length !== 1)
    throw Error('SEO requires a deterministic, generated page with one title and description');
  return {title, desc};
}
function seoHtml(html, href) {
  const {title, desc} = headInfo(html);
  // Existing renderer escapes title/description before interpolation. Adding
  // attributes here reuses those escaped values, avoiding a second escaping pass.
  const tags = '<link rel="canonical" href="' + esc(href) + '">' +
    '<meta property="og:type" content="website">' +
    '<meta property="og:title" content="' + title + '">' +
    '<meta property="og:description" content="' + desc + '">' +
    '<meta property="og:url" content="' + esc(href) + '">' +
    '<meta name="twitter:card" content="summary">';
  return html.replace('</head>', tags + '</head>');
}
const paths = new Map([
  ['public/index.html', '/'],
  ['public/about/index.html', '/about/'],
  ['public/services/index.html', '/services/'],
  ['public/contact/index.html', '/contact/']
]);
function generatedPages(sourceKind, site) {
  const normalized = normalizeSite(site);
  if (sourceKind === 'generated-one-page')
    return [{path: 'public/index.html', html: renderSite(normalized)}];
  const bundle = renderSiteBundle({...normalized, layout: 'multi-page'});
  return bundle.pages;
}

/**
 * Creates review-only HTML + robot/sitemap artifacts and digest. No I/O/writes.
 * The caller MUST derive trustedSite and domainEvidence from current authorized
 * owner/provider state, recheck expectedBaseSha and original file hashes at PR
 * creation, and require a separately recorded exact proposalSha256 approval.
 *
 * This API never asserts that a domain or published content is currently live.
 * Imported/customer ZIP files are never automatically transformed.
 */
export async function buildSeoReviewProposal({
  sourceKind, site, trustedSite, domainEvidence, existingPaths = []
} = {}) {
  if (!SITE_TYPES.has(sourceKind)) return deny('manual-review-required',
    'Imported ZIP and other customer-authored files cannot be modified automatically');
  // Copy all trust-bearing inputs before the first async digest, so an async
  // account/source switch can never silently retarget the resulting plan.
  const identity = trustedSite && typeof trustedSite === 'object'
    ? Object.freeze({...trustedSite}) : trustedSite;
  const evidence = domainEvidence && typeof domainEvidence === 'object'
    ? Object.freeze({...domainEvidence}) : domainEvidence;
  if (!validTrustedSite(identity)) return deny('blocked-site-identity',
    'Verified owned site, project and exact source revision are required');
  if (!evidenceMatches(identity, evidence)) return deny('blocked-domain-evidence',
    'Fresh matching domain ownership evidence is required for canonical URLs');
  if (!Array.isArray(existingPaths) || existingPaths.some(p => typeof p !== 'string'))
    return deny('blocked-file-inventory', 'Exact existing file paths must be reviewed');
  const existingSnapshot = Object.freeze([...existingPaths]);
  const existing = new Set(existingSnapshot);
  if (existingPaths.length !== existing.size ||
      existing.has('public/robots.txt') || existing.has('public/sitemap.xml'))
    return deny('blocked-existing-seo-file',
      'Existing SEO control files must be reviewed separately before replacement');

  // This only renders a new proposal; no existing live/customer file is patched.
  const origin = canonicalOrigin(evidence.origin);
  const normalizedSite = normalizeSite(site);
  const pages = generatedPages(sourceKind, normalizedSite);
  const files = [];
  const urls = [];
  for (const page of pages) {
    const route = paths.get(page.path);
    if (!route) throw Error('Unexpected generated static route');
    const href = origin + route;
    urls.push(href);
    const proposed = seoHtml(page.html, href);
    files.push(Object.freeze({
      path: page.path, action: 'review-update',
      beforeSha256: await hash(page.html),
      afterSha256: await hash(proposed),
      content: proposed
    }));
  }
  const robots = 'User-agent: *\nAllow: /\nSitemap: ' + origin + '/sitemap.xml\n';
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(url => '  <url><loc>' + xml(url) + '</loc></url>').join('\n') +
    '\n</urlset>\n';
  for (const [path, content] of [['public/robots.txt', robots], ['public/sitemap.xml', sitemap]]) {
    files.push(Object.freeze({path, action: 'review-create', beforeSha256: null,
      afterSha256: await hash(content), content}));
  }
  const manifest = files.map(f => [f.path, f.action, f.beforeSha256, f.afterSha256]);
  const proposalSha256 = await hash(JSON.stringify([
    'launch-and-own-seo-review-v1', sourceKind, identity.githubUserId,
    identity.githubRepositoryId, identity.cloudflareAccountId,
    identity.pagesProjectId, identity.pagesProjectName,
    identity.expectedBaseSha, origin, manifest
  ]));
  // A revoked/changing context cannot authorize a proposal started earlier.
  // The eventual hosted adapter must also revalidate its live auth epoch.
  let siteUnchanged = false;
  try { siteUnchanged = JSON.stringify(normalizeSite(site)) === JSON.stringify(normalizedSite); }
  catch { /* malformed input after async work must fail closed */ }
  const sameFields = (actual, snapshot) => Boolean(actual && snapshot &&
    Object.keys(snapshot).every(key => actual[key] === snapshot[key]));
  if (!siteUnchanged || !sameFields(trustedSite, identity) ||
      !sameFields(domainEvidence, evidence) ||
      existingPaths.length !== existingSnapshot.length ||
      existingPaths.some((path, i) => path !== existingSnapshot[i]) ||
      !evidenceMatches(identity, evidence))
    return deny('blocked-review-context-changed',
      'The source, owner, domain evidence or file inventory changed during review');
  return Object.freeze({
    status: 'review-required', reason: 'No existing file is changed until owner approval and Git PR verification',
    files: Object.freeze(files), proposalSha256, canonicalOrigin: origin,
    expectedBaseSha: identity.expectedBaseSha, publicationVerified: false,
    requiresOwnerApproval: true, requiresVerifiedGitUpdate: true
  });
}
