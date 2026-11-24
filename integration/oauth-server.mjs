/**
 * Minimal OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT):
 * RFC 8414 metadata, RFC 7591 dynamic registration (public clients only),
 * PKCE S256 authorization code, rotating refresh tokens.
 *
 * The grant only identifies an *agent session* (a fresh opaque subject). It
 * carries no GitHub/Cloudflare identity: owners bind later, in the browser,
 * through /agent-link and a sealed onboarding ticket. No provider tokens here.
 */
import {createHash, randomBytes} from 'node:crypto';
import {d1First, d1Run} from './d1-support.mjs';
import {RESOURCE_URI} from './protected-resource.mjs';
import {hasRepeatedFields, MAX_OAUTH_BODY_BYTES, readBridgeJson, readOAuthForm} from './request-body.mjs';
import {takeOAuthRequestSlot} from './oauth-rate-limit.mjs';

export const MCP_ORIGIN = new URL(RESOURCE_URI).origin;
export const SCOPE = 'launch_and_own.bridge';
const CODE_TTL = 120;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CLIENT_ID = /^mcpc_[a-f0-9]{24}$/;
const AUTHORIZATION_CODE = /^code_[a-f0-9]{64}$/;
const REFRESH_TOKEN = /^rt_[a-f0-9]{64}$/;
const ACCESS_TOKEN = /^agt_[a-f0-9]{48}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const s256 = value => createHash('sha256').update(value, 'ascii').digest('base64url');
const hex = bytes => randomBytes(bytes).toString('hex');

export function authorizationServerMetadata(origin = MCP_ORIGIN) {
  return {
    issuer: origin,
    authorization_endpoint: origin + '/authorize',
    token_endpoint: origin + '/token',
    registration_endpoint: origin + '/register',
    revocation_endpoint: origin + '/revoke',
    revocation_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE]
  };
}

/** https anywhere, or http only on loopback (native clients like Claude Code). */
export function allowedRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s#\\]/u.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  // The callback origin is also serialized into the consent page's CSP.
  const host = url.hostname;
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])$/i.test(host)) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders}
});
const oauthError = (error, status = 400) => json({error}, status);
const rateLimited = () => json({error: 'temporarily_unavailable'}, 429, {'retry-after': '60'});

const escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

function redirectTo(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  return new Response(null, {status: 302, headers: {location: url.href, 'cache-control': 'no-store'}});
}

async function loadClient(db, clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return null;
  const row = await d1First(db,
    'SELECT client_id, client_name, redirect_uris_json FROM bridge_oauth_clients WHERE client_id = ?',
    clientId);
  return row ? {id: row.client_id, name: row.client_name,
    redirectUris: JSON.parse(row.redirect_uris_json)} : null;
}

async function register(request, ctx) {
  const {db, nowSeconds} = ctx;
  let body;
  try { body = await readBridgeJson(request, MAX_OAUTH_BODY_BYTES); }
  catch (error) { return oauthError('invalid_client_metadata', error.status); }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5 ||
      !uris.every(allowedRedirectUri))
    return oauthError('invalid_redirect_uri');
  if (body.token_endpoint_auth_method !== undefined &&
      body.token_endpoint_auth_method !== 'none')
    return oauthError('invalid_client_metadata');
  const name = typeof body.client_name === 'string' ?
    body.client_name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100) : '';
  if (!await takeOAuthRequestSlot(request, ctx, 'register')) return rateLimited();
  const clientId = 'mcpc_' + hex(12);
  await d1Run(db, `INSERT INTO bridge_oauth_clients
    (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)`,
  clientId, name || 'MCP client', JSON.stringify(uris), nowSeconds);
  return json({
    client_id: clientId,
    client_id_issued_at: nowSeconds,
    client_name: name || 'MCP client',
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  }, 201);
}

/** Validate an authorize request. Returns {client, params} or {error, redirect?}. */
async function authorizeParams(db, get) {
  const client = await loadClient(db, get('client_id'));
  const redirectUri = get('redirect_uri');
  if (!client || !allowedRedirectUri(redirectUri) || !client.redirectUris.includes(redirectUri))
    return {error: 'Unknown client or redirect URI.'};
  const state = get('state') || undefined;
  const bad = error => ({error, redirect: redirectTo(redirectUri, {error, state})});
  if (get('response_type') !== 'code') return bad('unsupported_response_type');
  if (get('code_challenge_method') !== 'S256' || !CHALLENGE.test(get('code_challenge') || ''))
    return bad('invalid_request');
  const resource = get('resource');
  if (resource && resource !== RESOURCE_URI) return bad('invalid_target');
  return {client, params: {
    client_id: client.id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: get('code_challenge'), code_challenge_method: 'S256',
    state: state || '', resource: resource || ''
  }};
}

function consentPage(client, params) {
  const hidden = Object.entries(params).map(([k, v]) =>
    `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');
  const callback = new URL(params.redirect_uri);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow agent access — Launch &amp; Own</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #888;margin-right:.5rem;cursor:pointer}
.allow{background:#1a56db;color:#fff;border-color:#1a56db}.muted{color:#555;font-size:.9rem}</style></head><body>
<h1>Allow an AI agent to use Launch &amp; Own?</h1>
<p><strong>${escapeHtml(client.name)}</strong> (returns to <code>${escapeHtml(callback.host)}</code>) is asking to start a Launch &amp; Own agent session.</p>
<p>This does <strong>not</strong> connect GitHub or Cloudflare. If the agent later needs your accounts, it will send you to <code>onboard.360web.cloud</code> to confirm. Publishing still needs your separate approval in the browser.</p>
<form method="post" action="/authorize">${hidden}
<button class="allow" name="decision" value="allow">Allow</button>
<button name="decision" value="deny">Deny</button></form>
<p class="muted">Only allow agents you started yourself.</p></body></html>`;
  return new Response(html, {headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // Same-origin referrer so Chrome sends a real Origin on the form POST.
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; " +
      "form-action 'self' " + callback.origin
  }});
}

async function authorizeGet(url, {db}) {
  if (url.search.length > MAX_OAUTH_BODY_BYTES || hasRepeatedFields(url.searchParams))
    return oauthError('invalid_request');
  const v = await authorizeParams(db, k => url.searchParams.get(k));
  if (v.redirect) return v.redirect;
  if (v.error) return new Response(v.error, {status: 400, headers: {'content-type': 'text/plain'}});
  return consentPage(v.client, v.params);
}

async function authorizePost(request, ctx) {
  const {db, nowSeconds} = ctx;
  // Cross-site auto-submitted consent is refused.
  if (request.headers.get('origin') !== MCP_ORIGIN)
    return new Response('Forbidden', {status: 403, headers: {'content-type': 'text/plain'}});
  let form;
  try { form = await readOAuthForm(request); }
  catch (error) { return oauthError('invalid_request', error.status); }
  const v = await authorizeParams(db, k => form.get(k));
  if (v.redirect) return v.redirect;
  if (v.error) return new Response(v.error, {status: 400, headers: {'content-type': 'text/plain'}});
  const state = v.params.state || undefined;
  if (form.get('decision') !== 'allow')
    return redirectTo(v.params.redirect_uri, {error: 'access_denied', state});
  if (!await takeOAuthRequestSlot(request, ctx, 'authorize')) return rateLimited();
  const code = 'code_' + hex(32);
  // shortcut: each consent mints a new agent subject, so re-authorizing a client means re-linking via /agent-link.
  await d1Run(db, `INSERT INTO bridge_oauth_codes
    (code_hash, client_id, redirect_uri, code_challenge, subject, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  hash(code), v.client.id, v.params.redirect_uri, v.params.code_challenge,
  'sub_' + hex(16), nowSeconds + CODE_TTL);
  return redirectTo(v.params.redirect_uri, {code, state});
}

async function issueTokens({db, tokens, nowSeconds}, claim, subject, clientId) {
  const access = tokens.prepareIssue({subject, clientId, nowSeconds, ttlSeconds: ACCESS_TTL},
    {afterClaim: true});
  const refreshToken = 'rt_' + hex(32);
  const statements = [
    claim,
    access.statement,
    db.prepare(`INSERT INTO bridge_refresh_tokens
      (token_hash, subject, client_id, expires_at, revoked_at)
      SELECT ?, ?, ?, ?, NULL WHERE changes() = 1`)
      .bind(hash(refreshToken), subject, clientId, nowSeconds + REFRESH_TTL)
  ];
  // A losing code/refresh claim runs both INSERTs as no-ops. If an INSERT
  // fails, the batch rolls back the claim so the client can retry safely.
  const result = await db.batch(statements);
  if (result.length !== statements.length || !result.every(step => step.meta?.changes === 1))
    return null;
  return json({
    access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TTL,
    refresh_token: refreshToken, scope: SCOPE
  });
}

async function revokeGrant({db, nowSeconds}, subject, clientId) {
  // Any rotation either completes before this batch or loses its token claim.
  await db.batch([
    db.prepare(`UPDATE bridge_refresh_tokens SET revoked_at = ?
      WHERE subject = ? AND client_id = ? AND revoked_at IS NULL`)
      .bind(nowSeconds, subject, clientId),
    db.prepare(`UPDATE bridge_agent_tokens SET revoked_at = ?
      WHERE subject = ? AND client_id = ? AND revoked_at IS NULL`)
      .bind(nowSeconds, subject, clientId),
    db.prepare(`UPDATE bridge_link_challenges SET consumed_at = ?
      WHERE subject = ? AND client_id = ? AND consumed_at IS NULL`)
      .bind(nowSeconds, subject, clientId),
    db.prepare('DELETE FROM bridge_owner_links WHERE subject = ? AND client_id = ?')
      .bind(subject, clientId)
  ]);
}

async function token(request, ctx) {
  const {db, nowSeconds} = ctx;
  let form;
  try { form = await readOAuthForm(request); }
  catch (error) { return oauthError('invalid_request', error.status); }
  if (!await takeOAuthRequestSlot(request, ctx, 'token')) return rateLimited();
  const clientId = form.get('client_id');
  if (!(await loadClient(db, clientId))) return oauthError('invalid_client', 401);
  const resource = form.get('resource');
  if (resource && resource !== RESOURCE_URI) return oauthError('invalid_target');

  if (form.get('grant_type') === 'authorization_code') {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    if (!AUTHORIZATION_CODE.test(code || '') || !VERIFIER.test(verifier || ''))
      return oauthError('invalid_grant');
    const row = await d1First(db,
      'SELECT * FROM bridge_oauth_codes WHERE code_hash = ?', hash(code));
    if (!row || row.used_at !== null || row.expires_at <= nowSeconds ||
        row.client_id !== clientId || row.redirect_uri !== form.get('redirect_uri') ||
        s256(verifier) !== row.code_challenge)
      return oauthError('invalid_grant');
    const claim = db.prepare(`UPDATE bridge_oauth_codes SET used_at = ?
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
      .bind(nowSeconds, row.code_hash, nowSeconds);
    return await issueTokens(ctx, claim, row.subject, clientId) ?? oauthError('invalid_grant');
  }

  if (form.get('grant_type') === 'refresh_token') {
    const presented = form.get('refresh_token');
    if (!REFRESH_TOKEN.test(presented || ''))
      return oauthError('invalid_grant');
    const row = await d1First(db,
      'SELECT * FROM bridge_refresh_tokens WHERE token_hash = ?', hash(presented));
    if (!row || row.expires_at <= nowSeconds || row.client_id !== clientId)
      return oauthError('invalid_grant');
    if (row.revoked_at === null) {
      const claim = db.prepare(`UPDATE bridge_refresh_tokens SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
        .bind(nowSeconds, row.token_hash, nowSeconds);
      const response = await issueTokens(ctx, claim, row.subject, clientId);
      if (response) return response;
    }
    // A matching, unexpired token has already been used. Invalidate its whole
    // grant so a previously issued replacement cannot keep it active.
    await revokeGrant(ctx, row.subject, clientId);
    return oauthError('invalid_grant');
  }

  return oauthError('unsupported_grant_type');
}

async function revoke(request, ctx) {
  const {db, nowSeconds} = ctx;
  let form;
  try { form = await readOAuthForm(request); }
  catch (error) { return oauthError('invalid_request', error.status); }
  if (!await takeOAuthRequestSlot(request, ctx, 'revoke')) return rateLimited();
  const clientId = form.get('client_id');
  if (!(await loadClient(db, clientId))) return oauthError('invalid_client', 401);
  const token = form.get('token');
  if (!token) return oauthError('invalid_request');

  if (REFRESH_TOKEN.test(token)) {
    const grant = await d1First(db, `SELECT subject FROM bridge_refresh_tokens
      WHERE token_hash = ? AND client_id = ? AND expires_at > ?`, hash(token), clientId, nowSeconds);
    if (grant) await revokeGrant(ctx, grant.subject, clientId);
  } else if (ACCESS_TOKEN.test(token)) {
    await d1Run(db, `UPDATE bridge_agent_tokens SET revoked_at = ?
      WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL`,
    nowSeconds, hash(token), clientId);
  }
  return new Response(null, {status: 200, headers: {'cache-control': 'no-store'}});
}

/** Returns a Response for OAuth routes, or null when the path is not ours. */
export async function handleOAuth(request, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;
  if (path === '/.well-known/oauth-authorization-server' && method === 'GET')
    return json(authorizationServerMetadata());
  if (path === '/register' && method === 'POST') return register(request, ctx);
  if (path === '/authorize' && method === 'GET') return authorizeGet(url, ctx);
  if (path === '/authorize' && method === 'POST') return authorizePost(request, ctx);
  if (path === '/token' && method === 'POST') return token(request, ctx);
  if (path === '/revoke' && method === 'POST') return revoke(request, ctx);
  return null;
}
