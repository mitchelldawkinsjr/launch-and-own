// M2 worker-core tests (mocks only). IDs refer to docs/design/personal-assistant/m2-test-plan.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { accessKeyCache, verifyAccessJwt } from './access.mjs';
import { appJwt, mintInstallationToken, pkcs8FromPem } from './github-app.mjs';
import { reserveNeurons, usedNeurons } from './budget.mjs';
import { csrfToken, handle } from './worker.mjs';
import { d1ApprovalStore } from '../imported/approval-store.mjs';

const TEAM = 'team.cloudflareaccess.com', AUD = 'a'.repeat(64), OWNER = 'owner-sub-1', ORIGIN = 'https://assistant.example.test';
const NOW = Date.UTC(2026, 10, 26, 12);
const b64url = buf => Buffer.from(buf).toString('base64url');

async function accessKey(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  return { kid, privateKey: pair.privateKey, jwk: { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid } };
}
async function jwt(key, claims, header = {}) {
  const input = b64url(JSON.stringify({ alg: 'RS256', kid: key.kid, ...header })) + '.' + b64url(JSON.stringify(claims));
  return input + '.' + b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(input)));
}
const goodClaims = (over = {}) => ({ iss: 'https://' + TEAM, aud: [AUD], sub: OWNER, exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10, ...over });

function d1(...migrations) {
  const db = new DatabaseSync(':memory:');
  for (const m of migrations) db.exec(readFileSync(new URL(m, import.meta.url), 'utf8'));
  return { raw: db, prepare: sql => ({ bind: (...args) => ({
    first: async () => db.prepare(sql).get(...args) || null,
    run: async () => db.prepare(sql).run(...args),
    all: async () => ({ results: db.prepare(sql).all(...args) })
  }) }) };
}

const ghKeys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

async function setup({ keys, ghResponse, repoResponse } = {}) {
  const k1 = await accessKey('k1');
  const certs = { keys: [(keys || [k1]).map(k => k.jwk)].flat() };
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://' + TEAM + '/cdn-cgi/access/certs') return Response.json(certs);
    if (String(url).endsWith('/access_tokens')) return ghResponse ? ghResponse() : Response.json({ token: 'ghs_123_' + 'x'.repeat(57), expires_at: '2026-11-26T13:00:00Z', repositories: [{ id: 42 }], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }, { status: 201 });
    if (String(url) === 'https://api.github.com/repositories/42') return repoResponse ? repoResponse() : Response.json({ id: 42 });
    return new Response('unexpected', { status: 599 });
  };
  const env = {
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_SUB: OWNER, ASSISTANT_ORIGIN: ORIGIN, KEK: 'k'.repeat(32),
    WEBSITE_REPO_ID: '42', GH_APP_ID: '1001', GH_INSTALLATION_ID: '2002', GH_APP_PRIVATE_KEY: ghKeys.privateKey,
    DB: d1('./migrations/0001_assistant.sql'), ASSISTANT_VERSION: '0.1.0', UPSTREAM_SHA: 'b'.repeat(40)
  };
  const clock = { t: NOW };
  const opts = { fetchFn, now: () => clock.t, cache: accessKeyCache({ fetchFn, now: () => clock.t }) };
  const req = (path, { token, method = 'GET', origin, form } = {}) => handle(new Request(ORIGIN + path, {
    method, headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...(origin ? { origin } : {}) }, body: form ? new URLSearchParams(form) : undefined
  }), env, opts);
  return { k1, env, req, calls, certs, opts, clock };
}

test('T-ACC-6: healthz is static; everything else fails closed until Access is configured', async () => {
  const { env, req } = await setup();
  assert.equal((await req('/healthz')).status, 200);
  for (const missing of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OWNER_SUB', 'ASSISTANT_ORIGIN', 'KEK']) {
    const saved = env[missing]; delete env[missing];
    const res = await req('/status');
    assert.equal(res.status, 503, missing);
    env[missing] = saved;
  }
  env.KEK = 'short';
  assert.equal((await req('/status')).status, 503);
});

test('owner with a valid Access JWT sees status without secrets', async () => {
  const { k1, req } = await setup();
  const res = await req('/status', { token: await jwt(k1, goodClaims()) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.access, 'ok');
  assert.equal(body.github, 'configured');
  assert.equal(body.version, '0.1.0');
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE KEY|kkkkkkkk/);
});

test('T-ACC-1..5: missing, wrong-aud, wrong-iss, expired, not-yet-valid, tampered and non-owner tokens are refused', async () => {
  const { k1, req } = await setup();
  const bad = [
    undefined,
    await jwt(k1, goodClaims({ aud: ['other'] })),
    await jwt(k1, goodClaims({ iss: 'https://evil.cloudflareaccess.com' })),
    await jwt(k1, goodClaims({ exp: NOW / 1000 - 1 })),
    await jwt(k1, goodClaims({ nbf: NOW / 1000 + 60 })),
    await jwt(k1, goodClaims({ sub: 'someone-else' })),
    await jwt(k1, goodClaims(), { alg: 'HS256' }),
    (await jwt(k1, goodClaims())).replace(/\.[^.]+$/, '.' + b64url('forged'))
  ];
  for (const token of bad) assert.equal((await req('/status', { token })).status, 403);
});

test('T-ACC-3: unknown kids refetch certs at most once a minute; a rotated key is accepted after that', async () => {
  const { k1, req, calls, certs, clock } = await setup();
  const certFetches = () => calls.filter(c => c.url.endsWith('/certs')).length;
  assert.equal((await req('/status', { token: await jwt(k1, goodClaims()) })).status, 200);
  const k2 = await accessKey('k2');
  certs.keys.push(k2.jwk);
  const before = certFetches();
  for (let i = 0; i < 5; i++) assert.equal((await req('/status', { token: await jwt(k2, goodClaims()) })).status, 403, 'within the minute');
  assert.equal(certFetches(), before, 'random kids cannot force a fetch per request');
  clock.t += 61_000;
  const fresh = await jwt(k2, goodClaims({ exp: clock.t / 1000 + 600, nbf: clock.t / 1000 - 10 }));
  assert.equal((await req('/status', { token: fresh })).status, 200);
  assert.equal(certFetches(), before + 1);
});

test('malformed token segments return 403, never a 500', async () => {
  const { k1, req } = await setup();
  const good = await jwt(k1, goodClaims());
  const [h, p] = good.split('.');
  for (const token of [h + '.' + p + '.abcde', h + '.' + p + '.a', 'a.b.c', h + '.x.' + good.split('.')[2]]) {
    assert.equal((await req('/status', { token })).status, 403, token.slice(-8));
  }
});

test('T-ACC-7: POSTs need the exact origin and the per-owner CSRF token', async () => {
  const { k1, env, req } = await setup();
  const token = await jwt(k1, goodClaims());
  const csrf = await csrfToken(env, OWNER);
  assert.equal((await req('/self-check', { token, method: 'POST', form: { csrf } })).status, 403, 'no origin');
  assert.equal((await req('/self-check', { token, method: 'POST', origin: 'https://evil.example', form: { csrf } })).status, 403);
  assert.equal((await req('/self-check', { token, method: 'POST', origin: ORIGIN, form: { csrf: 'x'.repeat(64) } })).status, 403);
  assert.notEqual(await csrfToken(env, 'someone-else'), csrf);
  const ok = await req('/self-check', { token, method: 'POST', origin: ORIGIN, form: { csrf } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { github: 'ok' });
});

test('GitHub App JWT: PKCS#1 key is wrapped, RS256 signed, iat -60 s, exp within 10 minutes', async () => {
  assert.throws(() => pkcs8FromPem('not a key'));
  const token = await appJwt({ appId: '1001', privateKeyPem: ghKeys.privateKey, now: () => NOW });
  const [h, p, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.equal(claims.iss, '1001');
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.ok(claims.exp - NOW / 1000 <= 600);
  const pub = await crypto.subtle.importKey('spki', Buffer.from(ghKeys.publicKey.replace(/-----[^-]+-----|\s/g, ''), 'base64'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + p)));
});

test('installation tokens are restricted to the one repo and two permissions; variable-length tokens accepted', async () => {
  const { calls, opts } = await setup();
  const out = await mintInstallationToken({ appId: '1001', privateKeyPem: ghKeys.privateKey, installationId: '2002', repositoryId: 42, fetchFn: opts.fetchFn, now: opts.now });
  assert.match(out.token, /^ghs_/);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.deepEqual(body, { repository_ids: [42], permissions: { contents: 'write', pull_requests: 'write' } });
  assert.equal(calls.at(-1).init.redirect, 'manual');
});

test('T-REV-1..3: revoked App, key or installation fails closed as credentials_revoked', async () => {
  for (const status of [401, 403, 404]) {
    const { k1, env, req } = await setup({ ghResponse: () => new Response('{}', { status }) });
    const res = await req('/self-check', { token: await jwt(k1, goodClaims()), method: 'POST', origin: ORIGIN, form: { csrf: await csrfToken(env, OWNER) } });
    assert.deepEqual(await res.json(), { github: 'credentials_revoked' });
  }
});

test('a token response wider than requested is refused (T-ISO-1)', async () => {
  for (const extra of [{ repositories: [{ id: 42 }, { id: 43 }] }, { permissions: { contents: 'write', administration: 'write' } }]) {
    const { opts } = await setup({ ghResponse: () => Response.json({ token: 'ghs_x', ...extra }, { status: 201 }) });
    await assert.rejects(mintInstallationToken({ appId: '1001', privateKeyPem: ghKeys.privateKey, installationId: '2002', repositoryId: 42, fetchFn: opts.fetchFn, now: opts.now }), /scope_mismatch/);
  }
});

test('T-QUO-1: the daily Neuron budget is reserved atomically and refuses beyond the limit', async () => {
  const db = d1('./migrations/0001_assistant.sql');
  const now = () => NOW;
  assert.equal(await reserveNeurons(db, 5000, { limit: 8000, now }), true);
  assert.equal(await reserveNeurons(db, 3000, { limit: 8000, now }), true);
  assert.equal(await reserveNeurons(db, 1, { limit: 8000, now }), false);
  assert.equal(await usedNeurons(db, { now }), 8000);
  assert.equal(await reserveNeurons(db, 1, { limit: 8000, now: () => NOW + 86400000 }), true, 'resets next UTC day');
  for (const bad of [0, -1, 1.5, 9000]) assert.equal(await reserveNeurons(db, bad, { limit: 8000, now }), false);
});

test('same library, not a fork: the assistant schema matches 0012 and runs imported/approval-store unchanged', async () => {
  const table = sql => sql.match(/CREATE TABLE onboarding_imported_edit_approvals \([\s\S]*?\n\);/)[0];
  assert.equal(table(readFileSync(new URL('./migrations/0001_assistant.sql', import.meta.url), 'utf8')),
    table(readFileSync(new URL('../onboarding/migrations/0012_imported_edit_approvals.sql', import.meta.url), 'utf8')));
  const store = d1ApprovalStore(d1('./migrations/0001_assistant.sql'));
  const receipt = { approvalId: 'c'.repeat(32), repositoryId: 42, baseCommitSha: 'd'.repeat(40), artifactDigest: 'e'.repeat(64), owner: { provider: 'cloudflare_access', id: OWNER } };
  await store.claim(receipt);
  await assert.rejects(store.claim(receipt), /approval_consumed/);
});
