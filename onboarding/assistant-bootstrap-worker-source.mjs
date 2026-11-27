// Deployable bootstrap Worker for hosted assistant setup (ADR-001 D-style pilot).
// Uploaded verbatim into the customer's Cloudflare account. Fail-closed until Access
// vars + KEK are set. Full site-editor UI ships from the private assistant repo later;
// this shell is enough for /healthz, Access, /status and /self-check hand-off.
export const ASSISTANT_BOOTSTRAP_WORKER_MODULE = 'assistant.mjs';

export const ASSISTANT_BOOTSTRAP_WORKER_SOURCE = String.raw`
const HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const send = (status, body, type = 'text/plain; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': type } });
const asJson = (status, body) => send(status, body, 'application/json');

const b64url = text => {
  const pad = text + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const jsonPart = part => JSON.parse(new TextDecoder().decode(b64url(part)));

function accessConfigured(env) {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.OWNER_SUB && env.ASSISTANT_ORIGIN &&
    typeof env.KEK === 'string' && env.KEK.length >= 32);
}

async function verifyAccessJwt(token, env, now) {
  if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
  const [h, p, s] = token.split('.');
  let header, claims;
  try { header = jsonPart(h); claims = jsonPart(p); } catch { return null; }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const certs = await fetch('https://' + env.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs', { redirect: 'manual' });
  if (!certs.ok) return null;
  const body = await certs.json();
  const jwk = (Array.isArray(body?.keys) ? body.keys : []).find(k => k?.kid === header.kid && k.kty === 'RSA');
  if (!jwk) return null;
  let key;
  try {
    key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch { return null; }
  let ok = false;
  try { ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p)); } catch { return null; }
  if (!ok) return null;
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== 'https://' + env.ACCESS_TEAM_DOMAIN || !audiences.includes(env.ACCESS_AUD)) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= seconds) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return claims;
}

function githubConfig(env) {
  const repositoryId = Number(env.WEBSITE_REPO_ID);
  return env.GH_APP_ID && env.GH_INSTALLATION_ID && env.GH_APP_PRIVATE_KEY &&
    Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? { appId: env.GH_APP_ID, installationId: env.GH_INSTALLATION_ID, privateKeyPem: env.GH_APP_PRIVATE_KEY, repositoryId }
    : null;
}

async function selfCheck(env) {
  const gh = githubConfig(env);
  if (!gh) return { github: 'not_configured' };
  return { github: 'configured' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return send(200, 'ok');
    if (!accessConfigured(env)) return send(503, 'Access not configured');
    const claims = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), env, Date.now());
    if (!claims || claims.sub !== env.OWNER_SUB) return send(403, 'Forbidden');
    if (request.method === 'POST' && url.pathname === '/self-check')
      return asJson(200, await selfCheck(env));
    if (request.method === 'GET' && url.pathname === '/status') {
      return asJson(200, {
        version: env.ASSISTANT_VERSION || '0.1.0-bootstrap',
        upstreamSha: env.UPSTREAM_SHA || null,
        access: 'ok',
        github: githubConfig(env) ? 'configured' : 'not_configured',
        shell: 'hosted-bootstrap'
      });
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return send(200,
        '<!doctype html><html><head><meta charset="utf-8"><title>Your website assistant</title></head>' +
        '<body><h1>Your private website assistant</h1>' +
        '<p>Access is configured. Open <a href="/status">/status</a> for setup details.</p>' +
        '<p>This is the hosted bootstrap shell. Full editing ships from your private assistant repository.</p></body></html>',
        'text/html; charset=utf-8');
    }
    return send(404, 'Not found');
  }
};
`;
