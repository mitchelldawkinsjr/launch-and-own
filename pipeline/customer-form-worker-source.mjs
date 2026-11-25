// Deployable, self-contained customer contact-form Worker (#89).
// Uploaded verbatim to the customer's own Cloudflare account by the forms
// provider adapter. Mirrors customer-form-worker.mjs rules on the async D1 API:
// origin-locked, server-side Siteverify with hostname match, single-use tokens,
// byte-capped bodies, atomic daily quota, retention purge on cron. Never logs or
// returns secrets or submission data.
// shortcut: duplicates customer-form-worker.mjs checks because that module is not Worker-deployable (node:fs); unify when a bundler step exists.
export const CUSTOMER_FORM_WORKER_MODULE = 'form.mjs';

export const CUSTOMER_FORM_WORKER_SOURCE = String.raw`
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const json = (body, status, origin) => new Response(JSON.stringify(body), {status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store',
  ...(origin ? {'access-control-allow-origin': origin, vary: 'Origin'} : {})}});
async function hash(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const day = now => now - (now % 86400);
const num = v => Number.parseInt(v, 10);

// Read at most cap bytes of the actual body, whatever content-length claims.
async function readCapped(request, cap) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_FIELDS = 20;

// A plain HTML form submit goes back to the page it came from with ?form=sent or ?form=error;
// scripts that post with fetch keep getting JSON.
function responder(request, origin) {
  const type = request.headers.get('content-type') || '';
  const page = /^(?:application\/x-www-form-urlencoded|multipart\/form-data)/i.test(type) &&
    /text\/html/i.test(request.headers.get('accept') || '');
  let back = origin + '/';
  try {
    const referer = new URL(request.headers.get('referer') || '');
    if (referer.origin === origin) back = origin + referer.pathname;
  } catch {}
  return (ok, error, status) => {
    if (!page) return json(ok ? {ok: true} : {ok: false, error}, status, origin);
    const target = new URL(back);
    target.searchParams.set('form', ok ? 'sent' : 'error');
    if (!ok) target.searchParams.set('reason', error);
    target.hash = ok ? 'form-sent' : 'form-error';
    return new Response(null, {status: 303, headers: {location: target.href, 'cache-control': 'no-store'}});
  };
}

async function submit(request, env) {
  const host = env.SITE_HOSTNAME, origin = 'https://' + host;
  if (request.headers.get('origin') !== origin) return json({ok: false, error: 'origin_forbidden'}, 403);
  const reply = responder(request, origin);
  const maxBody = num(env.MAX_BODY_BYTES), maxDay = num(env.MAX_SUBMISSIONS_PER_DAY);
  // Envelope allowance covers field names, encoding and the Turnstile token (<= 2048).
  const raw = await readCapped(request, maxBody + 4096);
  if (!raw) return reply(false, 'body_too_large', 413);
  let form;
  try {
    form = await new Response(raw, {headers: {'content-type': request.headers.get('content-type') || ''}}).formData();
  } catch { return reply(false, 'invalid_form_body', 400); }
  // The site's own form fields are kept as sent: safe names only, bounded count and size.
  const fields = {};
  let count = 0;
  for (const [key, value] of form.entries()) {
    if (key === 'cf-turnstile-response') continue;
    if (typeof value !== 'string') return reply(false, 'files_not_accepted', 400);
    if (!FIELD_NAME.test(key) || Object.hasOwn(fields, key)) return reply(false, 'field_invalid', 400);
    if (++count > MAX_FIELDS) return reply(false, 'too_many_fields', 400);
    const text = value.trim();
    if (text.length > 4000) return reply(false, 'field_too_long', 400);
    fields[key] = text;
  }
  if (!Object.values(fields).some(Boolean)) return reply(false, 'form_empty', 400);
  const emailKey = Object.keys(fields).find(key => /e-?mail/i.test(key) && fields[key]);
  const email = emailKey ? fields[emailKey] : null;
  if (email !== null && (!EMAIL.test(email) || email.length > 254)) return reply(false, 'email_invalid', 400);
  const token = String(form.get('cf-turnstile-response') || '');
  if (token.length < 8 || token.length > 2048) return reply(false, 'turnstile_token_required', 400);
  const fieldsJson = JSON.stringify(fields);
  const bodyBytes = new TextEncoder().encode(fieldsJson).length;
  if (bodyBytes > maxBody) return reply(false, 'body_too_large', 413);
  const now = Math.floor(Date.now() / 1000), since = day(now), tokenHash = await hash(token);
  // Cheap early refusals; the authoritative checks are in the atomic write below.
  const today = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM contact_submissions WHERE hostname = ? AND created_at >= ?')
    .bind(host, since).first();
  if (Number(today?.n || 0) >= maxDay) return reply(false, 'daily_quota_exhausted', 429);
  if (await env.DB.prepare('SELECT 1 AS used FROM turnstile_token_uses WHERE token_hash = ?').bind(tokenHash).first())
    return reply(false, 'turnstile_token_reuse', 403);
  const body = new URLSearchParams({secret: env.TURNSTILE_SECRET, response: token});
  const ip = request.headers.get('cf-connecting-ip');
  if (ip && ip.length <= 64) body.set('remoteip', ip);
  let verdict;
  try {
    const res = await fetch(SITEVERIFY, {method: 'POST', body});
    verdict = res.status === 200 ? await res.json() : null;
  } catch { verdict = null; }
  if (verdict?.success !== true || String(verdict.hostname || '').toLowerCase() !== host)
    return reply(false, 'turnstile_siteverify_rejected', 403);
  // One transaction: the submission is written only while under today's cap, and the
  // token is recorded only with it. A replayed token hits the primary key and rolls back both.
  let written;
  try {
    [written] = await env.DB.batch([
      env.DB.prepare('INSERT INTO contact_submissions (id, hostname, gate_approval_id, fields_json, reply_email, ' +
        'body_bytes, turnstile_hostname, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? ' +
        'WHERE (SELECT COUNT(*) FROM contact_submissions WHERE hostname = ? AND created_at >= ?) < ?')
        .bind(crypto.randomUUID(), host, env.GATE_APPROVAL_ID, fieldsJson, email, bodyBytes, host, now,
          host, since, maxDay),
      env.DB.prepare('INSERT INTO turnstile_token_uses (token_hash, hostname, used_at) SELECT ?, ?, ? ' +
        'WHERE changes() = 1').bind(tokenHash, host, now)
    ]);
  } catch { return reply(false, 'turnstile_token_reuse', 403); }
  if (written?.meta?.changes !== 1) return reply(false, 'daily_quota_exhausted', 429);
  return reply(true, null, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = 'https://' + env.SITE_HOSTNAME;
    if (url.pathname === '/submit' && request.method === 'OPTIONS')
      return request.headers.get('origin') === origin ? new Response(null, {status: 204, headers: {
        'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'Origin'}})
        : new Response(null, {status: 403});
    if (url.pathname === '/submit' && request.method === 'POST') return submit(request, env);
    // Liveness only. Acceptance evidence is read by the owner through the Cloudflare API.
    if (url.pathname === '/health' && request.method === 'GET') return json({ok: true}, 200);
    return json({ok: false, error: 'not_found'}, 404);
  },
  async scheduled(event, env) {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - num(env.RETENTION_DAYS) * 86400;
    await env.DB.prepare('DELETE FROM contact_submissions WHERE created_at < ?').bind(cutoff).run();
    await env.DB.prepare('DELETE FROM turnstile_token_uses WHERE used_at < ?').bind(now - 86400).run();
  }
};
`;
