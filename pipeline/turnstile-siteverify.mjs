// Server-side Turnstile Siteverify contract (#89 / #88).
// Never logs secrets or raw tokens. A client widget alone is not acceptance.
import { TURNSTILE_FREE_LIMITS } from './plan-customer.mjs';

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;

function deny(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

/**
 * POST the official Siteverify endpoint. Caller must enforce single-use tokens
 * (e.g. mark consumed before trusting success) and never echo the secret.
 */
export async function verifyTurnstileToken({
  secret, token, hostname, remoteIp, fetchFn = globalThis.fetch, now = Date.now()
} = {}) {
  if (typeof secret !== 'string' || secret.length < 8 || secret.length > 256)
    deny('turnstile_secret_required');
  if (typeof token !== 'string' || token.length < 8 || token.length > 2048)
    deny('turnstile_token_required');
  if (typeof hostname !== 'string' || !HOST.test(hostname) || hostname.length > 253)
    deny('turnstile_hostname_required');
  if (typeof fetchFn !== 'function') deny('turnstile_fetch_required');
  if (!Number.isFinite(now)) deny('turnstile_clock_invalid');

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (typeof remoteIp === 'string' && remoteIp.length > 0 && remoteIp.length <= 64)
    body.set('remoteip', remoteIp);

  let response;
  try {
    response = await fetchFn(TURNSTILE_FREE_LIMITS.siteverifyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body
    });
  } catch {
    deny('turnstile_siteverify_unreachable');
  }
  if (!response || response.status !== 200) deny('turnstile_siteverify_http_error');

  let payload;
  try { payload = await response.json(); }
  catch { deny('turnstile_siteverify_invalid_json'); }

  if (payload?.success !== true) {
    const codes = Array.isArray(payload?.['error-codes'])
      ? payload['error-codes'].map(String).slice(0, 8)
      : [];
    const err = new Error('turnstile_siteverify_rejected');
    err.code = 'turnstile_siteverify_rejected';
    err.errorCodes = Object.freeze(codes);
    throw err;
  }
  if (typeof payload.hostname !== 'string' ||
      payload.hostname.toLowerCase() !== hostname.toLowerCase())
    deny('turnstile_hostname_mismatch');
  if (typeof payload.challenge_ts === 'string') {
    const ts = Date.parse(payload.challenge_ts);
    if (!Number.isFinite(ts) ||
        now - ts > TURNSTILE_FREE_LIMITS.tokenTtlSeconds * 1000 ||
        ts - now > 60_000)
      deny('turnstile_token_expired');
  }
  return Object.freeze({
    ok: true,
    hostname: payload.hostname.toLowerCase(),
    challengeTs: typeof payload.challenge_ts === 'string' ? payload.challenge_ts : null,
    action: typeof payload.action === 'string' ? payload.action.slice(0, 64) : null,
    siteverifyUrl: TURNSTILE_FREE_LIMITS.siteverifyUrl,
    singleUseRequired: true
  });
}

export const SITEVERIFY_URL = TURNSTILE_FREE_LIMITS.siteverifyUrl;
