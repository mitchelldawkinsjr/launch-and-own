import assert from 'node:assert/strict';
import test from 'node:test';
import { planCustomer } from './plan-customer.mjs';
import { prepareOptionalExtensionReview, PUBLISHED_FREE_LIMITS } from './optional-service-budget.mjs';
import {
  consumeStoredToolkitApproval,
  ToolkitApprovalExecutionError
} from './approved-extension-consumer.mjs';
import {
  buildFormsCostPrivacyReview,
  materializeApprovedFormsCostPrivacyRow,
  verifyStoredFormsCostPrivacyApproval,
  FORMS_COST_PRIVACY_SOURCE
} from './forms-cost-privacy-approval.mjs';

const account = 'a'.repeat(32);
const jobId = 'a1111111-1111-4111-8111-111111111111';
const formsDigest = planCustomer({
  name: 'Fern', accountId: account, githubOwner: 'siteowner',
  hostname: 'example.com', forms: true, formsConsent: true,
  ownerEmail: 'user@example.net'
}).formsReview.approvalDigest;

const base = {
  jobId,
  githubUserId: 42,
  cloudflareAccountId: account,
  pagesProjectId: 'pages_project_123',
  formsDigest,
  retentionDays: 30,
  maxSubmissionsPerDay: 50,
  maxBodyBytes: 4096,
  costApproved: true,
  privacyApproved: true
};

test('forms cost/privacy review binds exact #88 forms digest and stays inert', () => {
  const review = buildFormsCostPrivacyReview(base);
  assert.equal(review.status, 'awaiting_cost_privacy_storage');
  assert.equal(review.canActivate, false);
  assert.equal(review.canWrite, false);
  assert.equal(review.createResources, false);
  assert.equal(review.plan.formsDigest, formsDigest);
  assert.equal(review.plan.siteverifyRequired, true);
  assert.equal(review.approvalDigest.length, 64);
  assert.equal(buildFormsCostPrivacyReview(base).approvalDigest, review.approvalDigest);
});

test('missing cost or privacy ack, or bad limits, block without a digest', () => {
  for (const bad of [
    {costApproved: false, reason: 'cost_owner_approval_required'},
    {privacyApproved: false, reason: 'privacy_owner_approval_required'},
    {retentionDays: 0, reason: 'retention_days_out_of_range'},
    {retentionDays: 400, reason: 'retention_days_out_of_range'},
    {maxSubmissionsPerDay: 0, reason: 'max_submissions_per_day_out_of_range'},
    {maxBodyBytes: 100, reason: 'max_body_bytes_out_of_range'},
    {formsDigest: 'abc', reason: 'verified_owner_and_forms_digest_required'}
  ]) {
    const {reason, ...patch} = bad;
    const out = buildFormsCostPrivacyReview({...base, ...patch});
    assert.equal(out.status, 'blocked');
    assert.equal(out.reason, reason);
    assert.equal(out.approvalDigest, null);
  }
});

test('optional-service budget digest alone never becomes a forms gate', async () => {
  const now = Math.floor(Date.now() / 1000);
  const budget = await prepareOptionalExtensionReview({
    principal: {githubUserId: 42, cloudflareAccountId: account},
    site: {
      githubUserId: 42, cloudflareAccountId: account, repositoryId: 77,
      pagesProjectId: 'pages_project_123', baseCommitSha: 'b'.repeat(40),
      productionBranch: 'main'
    },
    accountEvidence: {
      kind: 'verified-account-plan-and-usage',
      githubUserId: 42, cloudflareAccountId: account,
      workersPlan: 'free',
      checkedAt: now - 30,
      expiresAt: now + 600,
      r2SubscriptionActive: false,
      usageByService: {
        workers: {requestsPerDay: 0, cpuMsPerInvocation: 0},
        d1: {rowsReadPerDay: 0, rowsWrittenPerDay: 0, storedGb: 0, databases: 0},
        kv: {
          readsPerDay: 0, writesPerDay: 0, deletesPerDay: 0, listsPerDay: 0,
          storedGb: 0, namespaces: 0
        },
        r2: {
          standardGbMonthsPerMonth: 0, classAOpsPerMonth: 0, classBOpsPerMonth: 0
        }
      },
      permissions: {workers: true, d1: true, kv: true, r2: false}
    },
    requests: [{
      service: 'd1', purpose: 'contact-submissions', dataClassification: 'personal',
      deletionPlan: 'time-bound', customerResourceScope: 'customer-owned-dedicated',
      resourceName: 'esp-fern-forms', retentionDays: 30,
      projectedUsage: {
        rowsReadPerDay: 100, rowsWrittenPerDay: 50, storedGb: 0.01, databases: 1
      }
    }]
  }, {now, assertCurrentAuthorization: async () => true});
  assert.equal(budget.canActivate, false);
  assert.ok(budget.planDigest);
  assert.throws(
    () => verifyStoredFormsCostPrivacyApproval({
      id: 'f2345678-1234-4234-8234-123456789abc',
      status: 'approved',
      job_id: jobId,
      github_user_id: 42,
      cloudflare_account_id: account,
      approval_digest: budget.planDigest,
      payload_json: JSON.stringify({
        formsDigest, pagesProjectId: 'pages_project_123',
        retentionDays: 30, maxSubmissionsPerDay: 50, maxBodyBytes: 4096,
        costApproved: true, privacyApproved: true
      })
    }, base),
    err => /cost_privacy_digest_mismatch/.test(err.message)
  );
  assert.equal(PUBLISHED_FREE_LIMITS.workers.metrics.cpuMsPerInvocation, 10);
});

test('stored approved row verifies into the consumer gate shape', () => {
  const review = buildFormsCostPrivacyReview(base);
  const row = materializeApprovedFormsCostPrivacyRow(review, {
    approvalId: 'f2345678-1234-4234-8234-123456789abc'
  });
  const gate = verifyStoredFormsCostPrivacyApproval(row, base);
  assert.equal(gate.authorized, true);
  assert.equal(gate.source, FORMS_COST_PRIVACY_SOURCE);
  assert.equal(gate.approvalId, row.id);
  assert.equal(gate.formsDigest, formsDigest);
  assert.equal(gate.costApproved, true);
  assert.equal(gate.privacyApproved, true);
  assert.equal(gate.retentionDays, 30);
  assert.equal(gate.maxSubmissionsPerDay, 50);
  assert.equal(gate.maxBodyBytes, 4096);
  assert.equal(gate.canActivate, false);
  assert.equal(gate.canWrite, false);
});

test('stored row rejects digest drift, wrong site, and unapproved status', () => {
  const review = buildFormsCostPrivacyReview(base);
  const row = materializeApprovedFormsCostPrivacyRow(review, {
    approvalId: 'f2345678-1234-4234-8234-123456789abc'
  });
  assert.throws(
    () => verifyStoredFormsCostPrivacyApproval({...row, status: 'stored'}, base),
    err => /cost_privacy_not_approved/.test(err.message)
  );
  assert.throws(
    () => verifyStoredFormsCostPrivacyApproval({
      ...row, approval_digest: '0'.repeat(64)
    }, base),
    err => /cost_privacy_digest_mismatch/.test(err.message)
  );
  assert.throws(
    () => verifyStoredFormsCostPrivacyApproval(row, {
      ...base, pagesProjectId: 'other_project'
    }),
    err => /cost_privacy_/.test(err.message)
  );
  assert.throws(
    () => verifyStoredFormsCostPrivacyApproval(row, {
      ...base, formsDigest: '0'.repeat(64)
    }),
    err => /cost_privacy_/.test(err.message)
  );
});

test('verified #89 gate unlocks mocked forms consumer; weak gate still fails closed', async () => {
  const review = buildFormsCostPrivacyReview(base);
  const costRow = materializeApprovedFormsCostPrivacyRow(review, {
    approvalId: 'f2345678-1234-4234-8234-123456789abc'
  });
  const formsRow = {
    id: 'b2222222-2222-4222-8222-222222222222',
    status: 'approved',
    kind: 'forms',
    job_id: jobId,
    github_user_id: 42,
    cloudflare_account_id: account,
    approval_digest: formsDigest,
    payload_json: JSON.stringify({
      hostname: 'example.com', name: 'Fern', ownerEmail: 'user@example.net'
    })
  };
  const calls = [];
  const api = {
    approvalId: formsRow.id,
    principal: {
      githubUserId: 42, githubLogin: 'siteowner', cloudflareAccountId: account
    },
    approvalStore: {
      async readApproved() { return formsRow; },
      async claimApproved() { calls.push('claim'); return true; },
      async finish() { calls.push('finish'); return true; },
      async fail() { calls.push('fail'); }
    },
    siteStore: {
      async readLiveSite() {
        return {
          jobId, githubUserId: 42, githubLogin: 'siteowner',
          cloudflareAccountId: account, status: 'live', repositoryId: 77,
          repositoryName: 'esp-fern', pagesProjectId: 'pages_project_123',
          pagesProjectName: 'esp-fern-site', productionBranch: 'main'
        };
      }
    },
    provider: {
      async readPagesProject() {
        return {
          name: 'esp-fern-site', id: 'pages_project_123',
          subdomain: 'esp-fern-site.pages.dev', production_branch: 'main',
          uses_functions: false,
          source: {type: 'github', config: {
            owner: 'siteowner', owner_id: 42, repo_name: 'esp-fern', repo_id: 77,
            production_deployments_enabled: true
          }},
          build_config: {root_dir: '', destination_dir: 'public', build_command: null}
        };
      },
      async readGithubRepository() {
        return {
          id: 77, name: 'esp-fern', private: true, default_branch: 'main',
          owner: {id: 42, login: 'siteowner'}
        };
      },
      async readPagesDomain() {
        return {name: 'example.com', status: 'active'};
      },
      async createTurnstileWidget() {
        calls.push('turnstile');
        return {sitekey: 'widgetkey', secret: 'secret-value'};
      },
      async createCustomerD1() {
        calls.push('d1');
        return {id: 'd1-db'};
      },
      async deployServerVerifiedFormWorker() {
        calls.push('worker');
        return {id: 'worker-1'};
      },
      async verifyFormAcceptance() {
        calls.push('acceptance');
        return {
          serverSiteverify: true, customerD1Bound: true, endToEndAccepted: true
        };
      }
    },
    assertCurrentAuthorization: async () => true,
    verifyFormsCostPrivacyGate: async (args) =>
      verifyStoredFormsCostPrivacyApproval(costRow, {
        jobId: args.jobId,
        githubUserId: args.owner.githubUserId,
        cloudflareAccountId: args.owner.cloudflareAccountId,
        pagesProjectId: args.site.pagesProjectId,
        formsDigest: args.formsDigest
      })
  };

  const out = await consumeStoredToolkitApproval(api);
  assert.equal(out.workingForm, true);
  assert.deepEqual(
    calls.filter(c => ['turnstile', 'd1', 'worker', 'acceptance'].includes(c)),
    ['turnstile', 'd1', 'worker', 'acceptance']
  );

  await assert.rejects(
    () => consumeStoredToolkitApproval({
      ...api,
      verifyFormsCostPrivacyGate: async () => ({authorized: true})
    }),
    err => err instanceof ToolkitApprovalExecutionError &&
      err.code === 'cost_privacy_gate_required'
  );
});
