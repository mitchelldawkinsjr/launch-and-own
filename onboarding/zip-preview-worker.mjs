import { readZipFile, readZipManifest } from './zip-artifacts.mjs';
import { verifyZipPreview } from './zip-preview-access.mjs';
import { contentType, readBounded } from './website-zip.mjs';

const cookieName = '__Host-website_zip_preview';
const headers = {
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin',
  'content-security-policy': "sandbox allow-scripts allow-same-origin; default-src 'none'; "
    + "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    + "font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; manifest-src 'self'; "
    + "worker-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'"
};

const unavailable = () => new Response('This private preview is unavailable. Open the preview again from Launch & Own.', {
  status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }
});

async function openPreview(request, env, url) {
  if (request.headers.get('origin') !== env.ONBOARDING_ORIGIN || !env.ONBOARDING_ORIGIN
      || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') || '')) return unavailable();
  const bytes = await readBounded(request.body, 1024);
  if (!bytes) return unavailable();
  const fields = new URLSearchParams(new TextDecoder().decode(bytes));
  if (fields.getAll('ticket').length !== 1) return unavailable();
  const ticket = fields.get('ticket');
  const claim = await verifyZipPreview(env, url, ticket);
  if (!claim) return unavailable();
  const maxAge = claim.expires - Math.floor(Date.now() / 1000);
  return new Response(null, { status: 303, headers: { ...headers, location: '/',
    'set-cookie': `${cookieName}=${ticket}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}` } });
}

function findFile(files, path, isNavigation) {
  const byPath = new Map(files.map(file => [file.path, file]));
  if (path === '') return { file: byPath.get('index.html') };
  const file = byPath.get(path) ?? byPath.get(path.endsWith('/') ? path + 'index.html' : path + '.html');
  if (file) return { file };
  if (!path.endsWith('/') && byPath.has(path + '/index.html')) return { redirect: true };
  const notFound = byPath.get('404.html');
  if (notFound) return { file: notFound, status: 404 };
  return { file: isNavigation ? byPath.get('index.html') : null };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/_open') return await openPreview(request, env, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return unavailable();
      const ticket = (request.headers.get('cookie') || '').split(';').map(part => part.trim())
        .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      // A capability grants read access only to this one bundle on this one origin.
      const claim = await verifyZipPreview(env, url, ticket);
      if (!claim) return unavailable();
      const files = await readZipManifest(env.ZIP_ARTIFACTS, claim.artifact, claim.stage);
      const path = decodeURIComponent(url.pathname.slice(1));
      const navigation = request.headers.get('sec-fetch-mode') === 'navigate';
      const { file, status = 200, redirect } = findFile(files, path, navigation);
      if (redirect) return new Response(null, { status: 308, headers: { ...headers, location: url.origin + url.pathname + '/' + url.search } });
      if (!file) return unavailable();
      const bytes = await readZipFile(env.ZIP_ARTIFACTS, claim.artifact, claim.stage, file);
      return new Response(request.method === 'HEAD' ? null : bytes, { status, headers: { ...headers,
        'content-type': contentType(file.path), 'content-length': String(file.size) } });
    } catch {
      return unavailable();
    }
  }
};
