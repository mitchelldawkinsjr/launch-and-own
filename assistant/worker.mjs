// Customer-owned assistant Worker (M2, #195). Runs in the customer's Cloudflare account; no Launch & Own runtime dependency.
// Fail closed: every route except /healthz needs Access configured, a valid Access JWT and the configured owner.
import { accessKeyCache, verifyAccessJwt } from './access.mjs';
import { DEFAULT_DAILY_NEURONS, usedNeurons } from './budget.mjs';
import { mintInstallationToken } from './github-app.mjs';
import { ImportedEditError } from '../imported/errors.mjs';

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

export async function handle(request, env, { fetchFn = fetch, now = () => Date.now(), cache } = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') return send(200, 'ok');
  if (!accessConfigured(env)) return send(503, 'Access not configured');

  cache ??= (keyCache ??= accessKeyCache({ fetchFn }));
  const claims = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, cache, now });
  // Owner identity is {provider: 'cloudflare_access', id: sub}; this deployment has exactly one owner.
  if (!claims || claims.sub !== env.OWNER_SUB) return send(403, 'Forbidden');

  if (request.method === 'POST') {
    if (request.headers.get('origin') !== env.ASSISTANT_ORIGIN) return send(403, 'Forbidden');
    const form = await request.formData().catch(() => null);
    if (!form || !constantTimeEqual(form.get('csrf'), await csrfToken(env, claims.sub))) return send(403, 'Forbidden');
    if (url.pathname === '/self-check') return asJson(200, await selfCheck(env, fetchFn));
    return send(404, 'Not found');
  }
  if (request.method !== 'GET') return send(405, 'Method not allowed');

  if (url.pathname === '/status') {
    const limit = Number(env.DAILY_NEURON_BUDGET) || DEFAULT_DAILY_NEURONS;
    return asJson(200, {
      version: env.ASSISTANT_VERSION || 'unknown', upstreamSha: env.UPSTREAM_SHA || 'unknown',
      access: 'ok', github: githubConfig(env) ? 'configured' : 'not_configured',
      ai: { usedToday: env.DB ? await usedNeurons(env.DB, { now }) : null, dailyLimit: limit },
      csrf: await csrfToken(env, claims.sub)
    });
  }
  return send(404, 'Not found');
}

export default { fetch: (request, env) => handle(request, env) };
