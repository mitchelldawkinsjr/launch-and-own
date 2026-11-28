// Customer-owned assistant Worker (M2, #195). Runs in the customer's Cloudflare account; no Launch & Own runtime dependency.
// Fail closed: every route except /healthz needs Access configured, a valid Access JWT and the configured owner.
import { accessKeyCache, verifyAccessJwt } from './access.mjs';
import { DEFAULT_DAILY_NEURONS, usedNeurons } from './budget.mjs';
import { mintInstallationToken } from './github-app.mjs';
import { ImportedEditError } from '../imported/errors.mjs';
import { editRoute } from './edit-flow.mjs';

const HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const send = (status, body, type = 'text/plain; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': type } });
const asJson = (status, body) => send(status, body, 'application/json');

let keyCache = null;

/** Per-owner CSRF token: HMAC(KEK, "csrf:" + Access sub). Stateless; stops cross-site POSTs riding the ambient Access cookie. */
export async function csrfToken(env, sub) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.KEK), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('csrf:' + sub)));
  return [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
}

const constantTimeEqual = (a, b) => typeof a === 'string' && a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

export function accessConfigured(env) {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.OWNER_SUB && env.ASSISTANT_ORIGIN && typeof env.KEK === 'string' && env.KEK.length >= 32);
}

function githubConfig(env) {
  const repositoryId = Number(env.WEBSITE_REPO_ID);
  return env.GH_APP_ID && env.GH_INSTALLATION_ID && env.GH_APP_PRIVATE_KEY && Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? { appId: env.GH_APP_ID, installationId: env.GH_INSTALLATION_ID, privateKeyPem: env.GH_APP_PRIVATE_KEY, repositoryId } : null;
}

/** Read-only setup check (provisioning plan step 7): mint a restricted token and read the website repo. No writes. */
async function selfCheck(env, fetchFn) {
  const gh = githubConfig(env);
  if (!gh) return { github: 'not_configured' };
  try {
    const { token } = await mintInstallationToken({ ...gh, fetchFn });
    const response = await fetchFn('https://api.github.com/repositories/' + gh.repositoryId, {
      redirect: 'manual', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'launch-and-own-assistant' }
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) return { github: 'credentials_revoked' };
    const repo = response.ok ? await response.json() : null;
    return { github: repo?.id === gh.repositoryId ? 'ok' : 'repository_mismatch' };
  } catch (error) {
    return { github: error instanceof ImportedEditError ? error.code : 'unavailable' };
  }
}

/** Access JWT from the assertion header, or CF_Authorization cookie (Workers Access POSTs often only have the cookie). */
function accessJwtFromRequest(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (typeof header === 'string' && header) return header;
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function sameOrigin(value, expected) {
  const a = String(value || '').replace(/\/+$/, '');
  const b = String(expected || '').replace(/\/+$/, '');
  return Boolean(a) && a === b;
}

export async function handle(request, env, { fetchFn = fetch, now = () => Date.now(), cache } = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') return send(200, 'ok');
  if (!accessConfigured(env)) return send(503, 'Access not configured');

  cache ??= (keyCache ??= accessKeyCache({ fetchFn }));
  const claims = await verifyAccessJwt(accessJwtFromRequest(request), { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, cache, now });
  // Owner identity is {provider: 'cloudflare_access', id: sub}; this deployment has exactly one owner.
  if (!claims) return send(403, 'Forbidden (access token). Sign in again at the assistant URL, then retry.');
  if (claims.sub !== env.OWNER_SUB) {
    return send(403,
      'Forbidden. Access signed you in as sub ' + claims.sub +
      '. Paste that exact value into Your Access sub in Launch & Own, then save again.');
  }

  const csrf = await csrfToken(env, claims.sub);
  let form = null;
  if (request.method === 'POST') {
    // Access + CSRF gate the owner. Reject a cross-site Origin when present; absence is OK
    // (Access often strips Origin; pages use referrer-policy that omits Referer).
    const sameHost = url.origin.replace(/\/+$/, '');
    const allowed = String(env.ASSISTANT_ORIGIN || '').replace(/\/+$/, '') || sameHost;
    const got = String(request.headers.get('origin') || '').replace(/\/+$/, '');
    let refererHost = '';
    try { refererHost = new URL(request.headers.get('referer') || '').origin.replace(/\/+$/, ''); } catch { /* ignore */ }
    const hostOk = (value) => sameOrigin(value, allowed) || sameOrigin(value, sameHost);
    if (got && got !== 'null' && !hostOk(got))
      return send(403, 'Forbidden (origin). Got ' + got + '; expected ' + allowed + '.');
    if ((!got || got === 'null') && refererHost && !hostOk(refererHost))
      return send(403, 'Forbidden (origin). Got referer ' + refererHost + '; expected ' + allowed + '.');
    if (url.pathname === '/visual-preview') {
      const edit = await editRoute(request, url, null, env, { sub: claims.sub, csrf, fetchFn, now: now() });
      return edit || send(404, 'Not found');
    }
    form = await request.formData().catch(() => null);
    if (!form || !constantTimeEqual(form.get('csrf'), csrf))
      return send(403, 'Forbidden (csrf). Reload the assistant home page and try again.');
    if (url.pathname === '/self-check') return asJson(200, await selfCheck(env, fetchFn));
  } else if (request.method !== 'GET') return send(405, 'Method not allowed');

  if (request.method === 'GET' && url.pathname.startsWith('/site-editor/') && env.ASSETS?.fetch) {
    const relative = url.pathname.slice('/site-editor'.length);
    if (relative.startsWith('/') && !relative.includes('..')) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = relative;
      assetUrl.search = '';
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', "default-src 'none'; script-src 'self' https://unpkg.com https://esm.sh 'sha256-AfmJSc5QuvGDXyNSsWg0p+yPCEM4Ax7GPPUQflvqTMQ='; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'self' https://esm.sh https://unpkg.com; worker-src 'self'; frame-src 'self' https://*.pages.dev https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
      headers.delete('x-frame-options');
      return new Response(response.body, { status: response.status, headers });
    }
  }

  const edit = await editRoute(request, url, form, env, { sub: claims.sub, csrf, fetchFn, now: now() });
  if (edit) return edit;
  if (request.method === 'POST') return send(404, 'Not found');

  if (url.pathname === '/status') {
    const limit = Number(env.DAILY_NEURON_BUDGET) || DEFAULT_DAILY_NEURONS;
    return asJson(200, {
      version: env.ASSISTANT_VERSION || 'unknown', upstreamSha: env.UPSTREAM_SHA || 'unknown',
      access: 'ok', github: githubConfig(env) ? 'configured' : 'not_configured',
      ai: { usedToday: env.DB ? await usedNeurons(env.DB, { now }) : null, dailyLimit: limit },
      csrf
    });
  }
  return send(404, 'Not found');
}

export default { fetch: (request, env) => handle(request, env) };
