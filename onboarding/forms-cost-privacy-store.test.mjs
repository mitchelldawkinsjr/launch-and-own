import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId, approvePreview, connectTenant, csrfFrom, harness, jobRow, makeDue,
  newPreview, post
} from './worker-test-support.mjs';
import {
  buildFormsCostPrivacyReview,
  materializeApprovedFormsCostPrivacyRow
} from '../pipeline/forms-cost-privacy-approval.mjs';
import {
  createFormsCostPrivacyGate, formsCostPrivacySchemaReady
} from './forms-cost-privacy-store.mjs';

async function live(h, t) {
  t.mock.method(globalThis, 'fetch', h.fetchFn);
  const tenant = await connectTenant(h);
  const jobId = await newPreview(h, tenant);
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, jobId)).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/launch', tenant.cookie, {csrf: tenant.csrf, id: jobId})).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id: jobId})).status, 303);
  tenant.csrf = csrfFrom(await (await h.request('/', {cookie: tenant.cookie})).text());
  return {tenant, jobId};
}

async function storeForms(h, tenant, jobId) {
  const fields = {
    csrf: tenant.csrf, id: jobId, kind: 'forms',
    ownerEmail: 'owner@example.net', formsConsent: 'true'
  };
  const prepared = await post(h, '/site-options-prepare', tenant.cookie, fields);
  assert.equal(prepared.status, 200);
  const digest = (await prepared.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    ...fields, digest
  })).status, 303);
  return h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(jobId, 'forms');
}

function insertCostGate(h, formsRow, overrides = {}) {
  const job = jobRow(h);
  const review = buildFormsCostPrivacyReview({
    jobId: job.id,
    githubUserId: job.github_user_id,
    cloudflareAccountId: accountId,
    pagesProjectId: job.pages_project_id,
    formsDigest: formsRow.approval_digest,
    retentionDays: 30,
    maxSubmissionsPerDay: 50,
    maxBodyBytes: 4096,
    costApproved: true,
    privacyApproved: true
  });
  const materialized = materializeApprovedFormsCostPrivacyRow(review, {
    approvalId: 'f2345678-1234-4234-8234-123456789abc'
  });
  const time = Math.floor(Date.now() / 1000);
  const values = {
    id: materialized.id,
    forms_option_approval_id: formsRow.id,
    job_id: job.id,
    github_user_id: job.github_user_id,
    cloudflare_account_id: accountId,
    pages_project_id: job.pages_project_id,
    forms_digest: formsRow.approval_digest,
    approval_digest: materialized.approval_digest,
    payload_json: materialized.payload_json,
    retention_days: 30,
    max_submissions_per_day: 50,
    max_body_bytes: 4096,
    operator_grant_id: 'forms-cost-' + materialized.id,
    approved_at: time,
    expires_at: time + 3600,
    status: 'approved',
    updated_at: time,
    ...overrides
  };
  const cols = Object.keys(values);
  h.sqlite.prepare(
    'INSERT INTO onboarding_forms_cost_privacy_approvals (' + cols.join(',') +
    ') VALUES (' + cols.map(() => '?').join(',') + ')'
  ).run(...Object.values(values));
  return values;
}

test('0008 schema is present and gate verifies the exact forms digest', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, jobId} = await live(h, t);
  assert.equal(await formsCostPrivacySchemaReady(h.env.DB), true);
  const forms = await storeForms(h, tenant, jobId);
  insertCostGate(h, forms);
  const session = h.sqlite.prepare(
    'SELECT * FROM onboarding_sessions ORDER BY created_at LIMIT 1'
  ).get();
  const current = {...session, hash: session.id_hash};
  const job = jobRow(h);
  const gate = createFormsCostPrivacyGate(h.env, current);
  const verified = await gate({
    jobId,
    owner: {
      githubUserId: job.github_user_id,
      cloudflareAccountId: accountId
    },
    site: {
      jobId, pagesProjectId: job.pages_project_id
    },
    formsDigest: forms.approval_digest
  });
  assert.equal(verified.authorized, true);
  assert.equal(verified.source, 'stored-cost-privacy-approval');
  assert.equal(verified.formsDigest, forms.approval_digest);
  assert.equal(verified.retentionDays, 30);
});

test('wrong tenant, revoked gate, and digest drift fail closed', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, jobId} = await live(h, t);
  const forms = await storeForms(h, tenant, jobId);
  insertCostGate(h, forms);
  const session = h.sqlite.prepare(
    'SELECT * FROM onboarding_sessions ORDER BY created_at LIMIT 1'
  ).get();
  const current = {...session, hash: session.id_hash};
  const job = jobRow(h);
  const gate = createFormsCostPrivacyGate(h.env, current);

  await assert.rejects(
    () => gate({
      jobId,
      owner: {githubUserId: 999, cloudflareAccountId: accountId},
      site: {jobId, pagesProjectId: job.pages_project_id},
      formsDigest: forms.approval_digest
    }),
    err => /cost_privacy_session_required/.test(err.message)
  );

  h.sqlite.prepare(
    "UPDATE onboarding_forms_cost_privacy_approvals SET status = 'revoked'"
  ).run();
  await assert.rejects(
    () => gate({
      jobId,
      owner: {
        githubUserId: job.github_user_id,
        cloudflareAccountId: accountId
      },
      site: {jobId, pagesProjectId: job.pages_project_id},
      formsDigest: forms.approval_digest
    }),
    err => /cost_privacy_gate_required/.test(err.message)
  );
});
