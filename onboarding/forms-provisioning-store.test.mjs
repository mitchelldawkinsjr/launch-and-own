import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createD1FormsProvisioningStore} from './forms-provisioning-store.mjs';
import {harness} from './worker-test-support.mjs';

const owner = {github_user_id: 42, cloudflare_account_id: 'a'.repeat(32)};
const ids = {optionApprovalId: 'opt-1', jobId: 'job-1'};
const DB_ID = '11111111-2222-3333-4444-555555555555';

const migrationDir = new URL('./migrations/', import.meta.url);
const receiptMigration = '0010_forms_provisioning_receipts.sql';
const apply = (sqlite, file) => sqlite.exec(readFileSync(new URL(file, migrationDir), 'utf8'));

function setup(t, {beforeReceiptMigration = false} = {}) {
  const {env, sqlite} = harness({withJobs: !beforeReceiptMigration});
  if (beforeReceiptMigration) {
    const previous = readdirSync(migrationDir).filter(file => /^000[4-9]_.*\.sql$/.test(file)).sort();
    for (const file of previous) apply(sqlite, file);
  }
  t.after(() => sqlite.close());
  const time = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO onboarding_launch_jobs(id, github_user_id, github_login, cloudflare_account_id,
    customer_name, site_slug, plan_json, approved_html, approval_digest, status, approved_at, updated_at,
    expires_at, next_attempt_at) VALUES (?, 42, 'tester', ?, 'Test', 'test', '{}', '', ?, 'queued', ?, ?, ?, ?)`)
    .run(ids.jobId, owner.cloudflare_account_id, 'a'.repeat(64), time, time, time + 3600, time);
  sqlite.prepare(`INSERT INTO onboarding_option_approvals(id, job_id, github_user_id, cloudflare_account_id,
    kind, approval_digest, payload_json, status, created_at, updated_at)
    VALUES (?, ?, 42, ?, 'forms', ?, '{}', 'stored', ?, ?)`)
    .run(ids.optionApprovalId, ids.jobId, owner.cloudflare_account_id, 'b'.repeat(64), time, time);
  return {env, sqlite};
}

test('forms receipts are owner- and job-scoped, gate-bound and write-once', async t => {
  const {env, sqlite} = setup(t);
  assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const store = createD1FormsProvisioningStore(env, owner, ids);
  assert.equal(await store.read(), null);
  const first = await store.record({gateApprovalId: 'gate_1', widgetSitekey: 'site1'});
  assert.equal(first.widgetSitekey, 'site1');
  assert.equal((await store.record({gateApprovalId: 'gate_1', databaseId: DB_ID})).databaseId, DB_ID);
  assert.equal((await store.record({gateApprovalId: 'gate_1', schemaApplied: true})).schemaApplied, true);
  assert.equal(await store.record({gateApprovalId: 'gate_1', databaseId: '99999999-2222-3333-4444-555555555555'}), null);
  assert.equal(await store.record({gateApprovalId: 'gate_2', widgetSitekey: 'other'}), null);
  assert.equal(await store.record({gateApprovalId: 'gate_1', schemaApplied: false}), null);
  assert.equal(await store.record({gateApprovalId: 'gate_1', secret: 'unapproved'}), null);
  const steps = {workerDeployed: false, workerSubdomainEnabled: false, workerScheduleSet: false, workerUrl: null};
  assert.deepEqual(await store.read(), {gateApprovalId: 'gate_1', widgetSitekey: 'site1',
    databaseId: DB_ID, schemaApplied: true, ...steps});
  assert.equal((await store.record({gateApprovalId: 'gate_1', workerDeployed: true})).workerDeployed, true);
  const address = await store.record({gateApprovalId: 'gate_1', workerSubdomainEnabled: true,
    workerUrl: 'https://esp-test-site-form.acct.workers.dev'});
  assert.equal(address.workerUrl, 'https://esp-test-site-form.acct.workers.dev');
  assert.equal(await store.record({gateApprovalId: 'gate_1', workerUrl: 'https://other.acct.workers.dev'}), null, 'write-once');
  assert.equal(await store.record({gateApprovalId: 'gate_1', workerDeployed: false}), null);

  const stranger = createD1FormsProvisioningStore(env, {...owner, github_user_id: 7}, ids);
  const otherJob = createD1FormsProvisioningStore(env, owner, {...ids, jobId: 'job-2'});
  assert.equal(await stranger.read(), null);
  assert.equal(await otherJob.read(), null);
  assert.equal(await otherJob.record({gateApprovalId: 'gate_1', widgetSitekey: 'elsewhere'}), null);
});


test('0010 upgrades a populated 0009 database and preserves the exact cost/privacy grant', t => {
  const {sqlite} = setup(t, {beforeReceiptMigration: true});
  sqlite.prepare(`INSERT INTO onboarding_forms_cost_privacy_approvals(id, forms_option_approval_id,
    job_id, github_user_id, cloudflare_account_id, pages_project_id, forms_digest, approval_digest,
    payload_json, retention_days, max_submissions_per_day, max_body_bytes, operator_grant_id,
    approved_at, expires_at, status, updated_at)
    VALUES ('old-gate', ?, ?, 42, ?, 'pages', ?, ?, '{"test":true}', 30, 50, 4096, 'operator', 1, 2, 'approved', 1)`)
    .run(ids.optionApprovalId, ids.jobId, owner.cloudflare_account_id, 'b'.repeat(64), 'c'.repeat(64));
  const gates = () => sqlite.prepare('SELECT * FROM onboarding_forms_cost_privacy_approvals').all();
  const before = gates();
  apply(sqlite, receiptMigration);
  assert.deepEqual(gates(), before);
  sqlite.prepare('UPDATE onboarding_option_approvals SET id = ? WHERE id = ?').run('opt-2', ids.optionApprovalId);
  assert.deepEqual(gates(), before);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
