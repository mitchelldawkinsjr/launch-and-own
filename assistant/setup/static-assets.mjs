// Workers Static Assets direct upload (developers.cloudflare.com/workers/static-assets/direct-upload, read 2026-11-27).
// Used by the hosted assistant upgrade so a bootstrapped assistant gets the site-editor canvas (ASSETS binding).
// Runs with the customer's own short-lived Cloudflare token during setup; nothing is kept afterwards.

const ACCOUNT = /^[a-f0-9]{32}$/i;
const API = 'https://api.cloudflare.com/client/v4/accounts/';

export const ASSETS_BINDING = Object.freeze({ type: 'assets', name: 'ASSETS' });

// shortcut: sha256(base64 + extension) truncated to 32 hex, the docs' own example; Cloudflare uses it only as a content key.
async function hashFile(base64, path) {
  const ext = /\.([^./]+)$/.exec(path)?.[1] || '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64 + ext)));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** files: [{ path: '/index.html', base64, contentType }]. Returns the manifest plus a hash index for uploads. */
export async function assetManifest(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 20_000) throw Error('assets_invalid');
  const manifest = {}, byHash = new Map();
  for (const f of files) {
    if (typeof f?.path !== 'string' || !/^\/[A-Za-z0-9._\-/]+$/.test(f.path) || f.path.includes('..') || typeof f.base64 !== 'string')
      throw Error('assets_invalid');
    const size = atob(f.base64).length;
    if (size > 25 * 1024 * 1024) throw Error('assets_too_large');
    const hash = await hashFile(f.base64, f.path);
    manifest[f.path] = { hash, size };
    byHash.set(hash, f);
  }
  return { manifest, byHash };
}

async function cf(fetchFn, url, token, init) {
  const response = await fetchFn(url, { ...init, redirect: 'manual', headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...init.headers } });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) throw Object.assign(Error('cloudflare_assets_' + response.status), { status: response.status });
  return data?.result || {};
}

/** Upload every asset not already stored and return the completion JWT for `metadata.assets.jwt` (valid one hour). */
export async function uploadStaticAssets({ accountId, workerName, cloudflareToken, files, fetchFn = fetch } = {}) {
  if (!ACCOUNT.test(accountId || '') || typeof workerName !== 'string' || !workerName || typeof cloudflareToken !== 'string' || !cloudflareToken)
    throw Error('assets_input_invalid');
  const { manifest, byHash } = await assetManifest(files);
  const session = await cf(fetchFn, API + accountId + '/workers/scripts/' + encodeURIComponent(workerName) + '/assets-upload-session', cloudflareToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest })
  });
  if (typeof session.jwt !== 'string' || !session.jwt) throw Error('assets_session_invalid');
  const buckets = Array.isArray(session.buckets) ? session.buckets : [];
  if (buckets.length === 0) return session.jwt; // everything already uploaded: the session JWT is the completion token
  let completion = null;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const f = byHash.get(hash);
      if (!f) throw Error('assets_unknown_hash');
      form.append(hash, new File([f.base64], hash, { type: f.contentType || 'application/octet-stream' }));
    }
    const result = await cf(fetchFn, API + accountId + '/workers/assets/upload?base64=true', session.jwt, { method: 'POST', body: form });
    if (typeof result.jwt === 'string' && result.jwt) completion = result.jwt;
  }
  if (!completion) throw Error('assets_upload_incomplete');
  return completion;
}
