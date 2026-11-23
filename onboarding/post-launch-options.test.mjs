import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId, approvePreview, connectTenant, csrfFrom, harness, jobRow, makeDue,
  newPreview, post
} from './worker-test-support.mjs';
import { optionApprovalsReady, optionsPathForJob } from './post-launch-options.mjs';
import { validateStoredOptionApproval } from '../pipeline/stored-option-approval.mjs';

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

async function prepareDomain(h, tenant, id, hostname = 'www.example.com') {
  const response = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const digest = html.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  return { html, digest };
}

test('options path is only for live launch ids', () => {
  assert.equal(optionsPathForJob('11111111-1111-4111-8111-111111111111', 'live'),
    '/site-options?id=11111111-1111-4111-8111-111111111111');
  assert.equal(optionsPathForJob('11111111-1111-4111-8111-111111111111', 'queued'), null);
  assert.equal(optionsPathForJob('bad', 'live'), null);
});

test('toolkit links the options page and approvals store without provider writes', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);
  assert.equal(await optionApprovalsReady(h.DB), true);

  const toolkit = await (await h.request('/toolkit', { cookie: tenant.cookie })).text();
  assert.match(toolkit, new RegExp('/site-options\\?id=' + id));

  const writesBefore = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE'
  ).length;

  const { digest } = await prepareDomain(h, tenant, id);
  const saved = await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest
  });
  assert.equal(saved.status, 303);

  const row = h.sqlite.prepare(
    'SELECT kind, status, approval_digest FROM onboarding_option_approvals WHERE job_id = ?'
  ).get(id);
  assert.equal(row.kind, 'domain');
  assert.equal(row.status, 'stored');
  assert.equal(row.approval_digest, digest);

  const writesAfter = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE'
  ).length;
  assert.equal(writesAfter, writesBefore);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /Stored domain request/);
  assert.match(page, /www\.example\.com/);
  assert.match(page, /Existing mailbox/);
});

test('a bad digest does not store an options approval', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);
  await prepareDomain(h, tenant, id);
  const response = await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest: 'a'.repeat(64)
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /changed/i);
  assert.equal(h.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM onboarding_option_approvals WHERE job_id = ?'
  ).get(id).n, 0);
});

test('another tenant cannot open or approve options for a live site', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  h.resourceState.githubUserId = 99;
  const other = await connectTenant(h);
  const denied = await h.request('/site-options?id=' + id, { cookie: other.cookie });
  assert.equal(denied.status, 404);

  const prepare = await post(h, '/site-options-prepare', other.cookie, {
    csrf: other.csrf, id, kind: 'domain', hostname: 'www.example.com'
  });
  assert.equal(prepare.status, 404);
  assert.equal(h.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM onboarding_option_approvals'
  ).get().n, 0);
  assert.equal(accountId.length, 32);
});

test('email stays closed until a domain approval is stored', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /Save a custom domain request first/);
  assert.doesNotMatch(page, /name="mailbox"/);

  const early = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com'
  });
  assert.equal(early.status, 400);
  assert.match(await early.text(), /custom domain/i);

  const { digest } = await prepareDomain(h, tenant, id);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest
  })).status, 303);

  const emailPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com'
  });
  assert.equal(emailPrep.status, 200);
  const emailHtml = await emailPrep.text();
  const emailDigest = emailHtml.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(emailDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com', digest: emailDigest
  })).status, 303);
  const emailRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'email');
  const payload = JSON.parse(emailRow.payload_json);
  assert.equal(payload.plan.kind, 'launch-and-own-email-routing-approval');
  assert.equal(payload.plan.mailbox, 'you@elsewhere.com');
  assert.equal(payload.plan.alias, 'contact@www.example.com');
  assert.equal(emailRow.approval_digest, emailDigest);
  const job = jobRow(h);
  const validated = validateStoredOptionApproval(emailRow, {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  });
  assert.equal(validated.kind, 'email');
  assert.equal(validated.normalizedPayload.mailbox, 'you@elsewhere.com');
  assert.equal(validated.canWrite, false);
  assert.equal(h.sqlite.prepare(
    'SELECT kind FROM onboarding_option_approvals WHERE job_id = ? ORDER BY kind'
  ).all(id).map(row => row.kind).join(','), 'domain,email');

  const sameHost = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'owner@www.example.com'
  });
  assert.equal(sameHost.status, 400);
});

test('forms without consent cannot be stored', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const denied = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com'
  });
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /consent/i);

  const prepared = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com', formsConsent: 'true'
  });
  assert.equal(prepared.status, 200);
  const html = await prepared.text();
  assert.match(html, /does not create a working form|No widget/i);
  const digest = html.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com',
    formsConsent: 'true', digest
  })).status, 303);

  const payload = JSON.parse(h.sqlite.prepare(
    'SELECT payload_json FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'forms').payload_json);
  assert.equal(payload.workingForm, false);
  assert.equal(payload.createResources, false);
  assert.equal(payload.canActivate, false);
});

test('analytics and preview opt-ins store without enabling provider settings', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /Visitor insights/);
  assert.match(page, /Private update previews/);

  assert.equal((await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'analytics'
  })).status, 400);

  const analyticsPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'analytics', analyticsConsent: 'true'
  });
  assert.equal(analyticsPrep.status, 200);
  const analyticsDigest = (await analyticsPrep.text())
    .match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(analyticsDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'analytics', analyticsConsent: 'true', digest: analyticsDigest
  })).status, 303);

  assert.equal((await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'pr_previews', previewConsent: 'true'
  })).status, 400);

  const previewPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'pr_previews',
    previewConsent: 'true', acknowledgePublicPreviews: 'true'
  });
  assert.equal(previewPrep.status, 200);
  const previewHtml = await previewPrep.text();
  assert.match(previewHtml, /Access is reviewed|preview builds stay off/i);
  const previewDigest = previewHtml.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(previewDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'pr_previews',
    previewConsent: 'true', acknowledgePublicPreviews: 'true', digest: previewDigest
  })).status, 303);

  const job = jobRow(h);
  const analyticsRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'analytics');
  const previewRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'pr_previews');
  const analytics = validateStoredOptionApproval(analyticsRow, {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  });
  const preview = validateStoredOptionApproval(previewRow, {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  });
  assert.equal(analytics.canActivate, false);
  assert.equal(preview.normalizedPayload.accessPolicyRequired, true);
  assert.equal(JSON.parse(analyticsRow.payload_json).canWrite, false);
  assert.equal(JSON.parse(previewRow.payload_json).plan.accessPolicyRequired, true);
  // Options storage must not PATCH Pages settings or touch analytics/preview APIs.
  assert.equal(h.calls.filter(c =>
    (c.method === 'PATCH' || c.method === 'PUT') &&
    /pages\/projects|analytics|preview_deployment/i.test(c.url)
  ).length, 0);
});