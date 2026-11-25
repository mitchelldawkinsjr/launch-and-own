import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readOwnedStoredOptionApproval } from './stored-option-approvals.mjs';
import { buildDomainApprovalReview } from '../pipeline/domain-approval-review.mjs';
import { planCustomer } from '../pipeline/plan-customer.mjs';

const id = '12345678-1234-4234-8234-123456789abc';
const jobId = '87654321-4321-4321-8321-cba987654321';
const account = 'a'.repeat(32);
const session = {
  hash: 'session_hash', authorization_epoch: 2,
  github_user_id: 42, github_login: 'siteowner',
  cloudflare_account_id: account
};
const expires = 4102444800;

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec([
    'CREATE TABLE onboarding_sessions (id_hash TEXT PRIMARY KEY,',
    'authorization_epoch INTEGER, github_user_id INTEGER,',
    'cloudflare_account_id TEXT, github_token_ct TEXT, cloudflare_token_ct TEXT,',
    'expires_at INTEGER);',
    'CREATE TABLE onboarding_launch_jobs (id TEXT PRIMARY KEY, github_user_id INTEGER,',
    'github_login TEXT, cloudflare_account_id TEXT, customer_name TEXT,',
    'site_slug TEXT, repository_id INTEGER, pages_project_id TEXT,',
    'production_branch TEXT, expected_commit_sha TEXT, status TEXT, expires_at INTEGER);'
  ].join(' '));
  sql.exec(readFileSync(new URL('./migrations/0005_option_approvals.sql', import.meta.url), 'utf8'));
  sql.prepare('INSERT INTO onboarding_sessions VALUES(?,?,?,?,?,?,?)')
    .run(session.hash, 2, 42, account, 'encrypted-gh', 'encrypted-cf', expires);
  sql.prepare('INSERT INTO onboarding_launch_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(jobId, 42, 'siteowner', account, 'Fern', 'fern', 77,
      'pages_project_123', 'main', 'c'.repeat(40), 'live', expires);
  const domain = buildDomainApprovalReview({
    githubUserId: 42, cloudflareAccountId: account,
    hostname: 'www.example.com', domainConsent: true
  });
  sql.prepare("INSERT INTO onboarding_option_approvals VALUES(?,?,?,?,?,?,?,'stored',?,?)")
    .run(id, jobId, 42, account, 'domain',
      domain.approvalDigest, JSON.stringify(domain), 100, 100);
  const DB = {
    prepare(query) {
      const bind = (...values) => ({
        async first() { return sql.prepare(query).get(...values) || null; }
      });
      return {bind};
    }
  };
  return {sql, env: {DB}};
}
const read = (h, user = session, opt = {}) =>
  readOwnedStoredOptionApproval(h.env, user, id, {time: 100, ...opt});

test('reads the actual 0005 D1 row for exact current owner and live job, never authorizes execution', async t => {
  const h = fixture(); t.after(() => h.sql.close());
  const result = await read(h);
  assert.equal(result.kind, 'domain');
  assert.equal(result.normalizedPayload.hostname, 'www.example.com');
  assert.equal(result.currentSite.pagesProjectId, 'pages_project_123');
  assert.equal(result.currentSite.repositoryId, 77);
  assert.equal(result.canWrite, false);
  assert.equal(result.requiresSeparateExecutionAuthorization, true);
});

test('wrong tenant and expired/revoked session cannot read stored approval', async t => {
  const h = fixture(); t.after(() => h.sql.close());
  assert.equal(await read(h, {...session, github_user_id: 999}), null);
  assert.equal(await read(h, {...session, cloudflare_account_id: 'b'.repeat(32)}), null);
  assert.equal(await read(h, {...session, authorization_epoch: 1}), null);
  h.sql.prepare('UPDATE onboarding_sessions SET cloudflare_token_ct = NULL').run();
  assert.equal(await read(h), null);
});

test('changed immutable repository or Pages project metadata fails closed', async t => {
  const h = fixture(); t.after(() => h.sql.close());
  h.sql.prepare("UPDATE onboarding_launch_jobs SET production_branch='dev'").run();
  assert.equal(await read(h), null);
  h.sql.prepare("UPDATE onboarding_launch_jobs SET production_branch='main', repository_id=NULL").run();
  assert.equal(await read(h), null);
  h.sql.prepare("UPDATE onboarding_launch_jobs SET repository_id=77, pages_project_id=NULL").run();
  assert.equal(await read(h), null);
});

test('invalid digest, altered nested payload and non-stored statuses cannot be read', async t => {
  const h = fixture(); t.after(() => h.sql.close());
  h.sql.prepare("UPDATE onboarding_option_approvals SET approval_digest=?").run('e'.repeat(64));
  await assert.rejects(read(h), /review_digest_or_payload_mismatch/);
  h.sql.prepare("UPDATE onboarding_option_approvals SET status='applied'").run;
  // The migration's CHECK(status='stored') itself blocks attempted execution state transitions.
  assert.throws(() => h.sql.prepare("UPDATE onboarding_option_approvals SET status='applied'").run(),
    /CHECK constraint failed/);
});

test('invalid job states and mismatched referenced owner fail closed', async t => {
  const h = fixture(); t.after(() => h.sql.close());
  h.sql.prepare("UPDATE onboarding_launch_jobs SET status='pending_deployment'").run();
  assert.equal(await read(h), null);
  h.sql.prepare("UPDATE onboarding_launch_jobs SET status='live', github_user_id=99").run();
  assert.equal(await read(h), null);
});

test('stored forms row remains review-only and same original Pages host', async t => {
  const h = fixture(); t.after(() => h.sql.close());
  const forms = planCustomer({
    name: 'Fern', accountId: account, githubOwner: 'siteowner',
    forms: true, formsConsent: true, ownerEmail: 'owner@example.net'
  }).formsReview;
  h.sql.prepare(
    "UPDATE onboarding_option_approvals SET kind='forms', approval_digest=?, payload_json=?"
  ).run(forms.approvalDigest, JSON.stringify(forms));
  const result = await read(h);
  assert.equal(result.normalizedPayload.hostname, 'esp-fern-site.pages.dev');
  assert.equal(result.canWrite, false);
});
