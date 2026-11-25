import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvePreview, connectTenant, csrfFrom, harness, makeDue, newPreview, post
} from './worker-test-support.mjs';
import { blockedOptionApplyReason } from './apply-stored-options.mjs';

async function liveSite(h, t) {
  t.mock.method(globalThis, 'fetch', h.fetchFn);
  const tenant = await connectTenant(h);
  const id = await newPreview(h, tenant);
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/launch', tenant.cookie, { csrf: tenant.csrf, id })).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/verify', tenant.cookie, { csrf: tenant.csrf, id })).status, 303);
  tenant.csrf = csrfFrom(await (await h.request('/', { cookie: tenant.cookie })).text());
  return { tenant, id };
}

async function storeDomain(h, tenant, id, hostname = 'www.example.com') {
  const prepared = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname
  });
  assert.equal(prepared.status, 200);
  const digest = (await prepared.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname, digest
  })).status, 303);
  return digest;
}

test('blocked apply reasons stay explicit for email and forms', () => {
  assert.match(blockedOptionApplyReason('email'), /MX/i);
  assert.match(blockedOptionApplyReason('forms'), /#89/);
});

test('legacy #121 domain apply is blocked: stored approval alone makes no Cloudflare writes', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);
  const digest = await storeDomain(h, tenant, id);
  const before = h.calls.filter(c =>
    c.method === 'POST' && c.url.endsWith('/pages/projects/esp-willow-studio-site/domains')).length;
  const applied = await post(h, '/site-options-apply', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', digest
  });
  assert.equal(applied.status, 403);
  assert.match(await applied.text(), /operator-approved execution grant/i);
  assert.equal(h.calls.filter(c =>
    c.method === 'POST' && c.url.endsWith('/pages/projects/esp-willow-studio-site/domains')).length, before);
  assert.equal(h.resourceState.customDomain, null);
});

test('email and forms apply stay blocked even with a stored row', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);
  const domainDigest = await storeDomain(h, tenant, id);

  const emailPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com'
  });
  const emailDigest = (await emailPrep.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com', digest: emailDigest
  })).status, 303);

  const emailApply = await post(h, '/site-options-apply', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', digest: emailDigest
  });
  assert.equal(emailApply.status, 403);
  assert.match(await emailApply.text(), /operator-approved/i);

  const formsPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com', formsConsent: 'true'
  });
  const formsDigest = (await formsPrep.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com',
    formsConsent: 'true', digest: formsDigest
  })).status, 303);
  const formsApply = await post(h, '/site-options-apply', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', digest: formsDigest
  });
  assert.equal(formsApply.status, 403);
  assert.match(await formsApply.text(), /operator-approved/i);
  assert.equal(domainDigest.length, 64);
});
