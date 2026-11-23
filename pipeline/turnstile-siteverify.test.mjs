import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTurnstileToken, SITEVERIFY_URL } from './turnstile-siteverify.mjs';

const secret = '0xsecret-test-value';
const token = 'tok_' + 'a'.repeat(40);
const hostname = 'example.com';
const now = Date.parse('2026-11-22T12:00:00Z');

test('Siteverify success returns sanitized hostname without leaking the secret', async () => {
  const calls = [];
  const out = await verifyTurnstileToken({
    secret, token, hostname, now,
    fetchFn: async (url, options) => {
      calls.push({url, options});
      return {
        status: 200,
        async json() {
          return {
            success: true,
            hostname: 'Example.com',
            challenge_ts: '2026-11-22T11:59:30Z',
            action: 'contact'
          };
        }
      };
    }
  });
  assert.equal(out.ok, true);
  assert.equal(out.hostname, 'example.com');
  assert.equal(out.singleUseRequired, true);
  assert.equal(out.siteverifyUrl, SITEVERIFY_URL);
  assert.equal(calls[0].url, SITEVERIFY_URL);
  assert.equal(calls[0].options.method, 'POST');
  const body = String(calls[0].options.body);
  assert.match(body, /secret=/);
  assert.equal(JSON.stringify(out).includes(secret), false);
});

test('hostname mismatch, rejected token, and expired challenge fail closed', async () => {
  await assert.rejects(
    () => verifyTurnstileToken({
      secret, token, hostname, now,
      fetchFn: async () => ({
        status: 200,
        async json() { return {success: true, hostname: 'other.com'}; }
      })
    }),
    err => err.code === 'turnstile_hostname_mismatch'
  );
  await assert.rejects(
    () => verifyTurnstileToken({
      secret, token, hostname, now,
      fetchFn: async () => ({
        status: 200,
        async json() {
          return {success: false, 'error-codes': ['timeout-or-duplicate']};
        }
      })
    }),
    err => err.code === 'turnstile_siteverify_rejected' &&
      err.errorCodes.includes('timeout-or-duplicate')
  );
  await assert.rejects(
    () => verifyTurnstileToken({
      secret, token, hostname, now,
      fetchFn: async () => ({
        status: 200,
        async json() {
          return {
            success: true, hostname,
            challenge_ts: '2026-11-22T10:00:00Z'
          };
        }
      })
    }),
    err => err.code === 'turnstile_token_expired'
  );
});

test('missing secret or token never calls Siteverify', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return {status: 200, async json() { return {}; }}; };
  await assert.rejects(() => verifyTurnstileToken({token, hostname, fetchFn}),
    err => err.code === 'turnstile_secret_required');
  await assert.rejects(() => verifyTurnstileToken({secret, hostname, fetchFn}),
    err => err.code === 'turnstile_token_required');
  assert.equal(called, false);
});
