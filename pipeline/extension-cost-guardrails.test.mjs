import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  FREE_ALLOWANCES,
  EXTENSION_IDS,
  listExtensionCatalog,
  assessExtensionEligibility,
  buildExtensionReviewPlan,
  projectBudgetPause
} from './extension-cost-guardrails.mjs';
import { TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';

const account = 'a'.repeat(32);
const now = 1_795_400_000;

function owner(overrides = {}) {
  return {
    githubUserId: 10,
    githubLogin: 'customer',
    cloudflareAccountId: account,
    siteId: 'site_fixture',
    pagesProjectId: 'project-fixture',
    repositoryId: 42,
    repositoryName: 'esp-fixture-site',
    branch: 'main',
    ...overrides
  };
}

function plan(overrides = {}) {
  return {
    workersPlan: 'workers_free',
    cloudflareAccountId: account,
    r2Activated: false,
    checkedAt: now - 60,
    expiresAt: now + 3600,
    source: 'manual_dashboard',
    ...overrides
  };
}

test('catalog lists Workers/D1/KV/R2 with Free allowances and platform-resource distinctions', () => {
  const catalog = listExtensionCatalog();
  assert.deepEqual(catalog.map(item => item.id), [...EXTENSION_IDS]);
  assert.equal(FREE_ALLOWANCES.pages_functions.cpuMsPerInvocation, 10);
  assert.equal(FREE_ALLOWANCES.pages_functions.requestsPerDay, 100_000);
  assert.equal(FREE_ALLOWANCES.d1.databases, 10);
  assert.equal(FREE_ALLOWANCES.kv.writesPerDay, 1_000);
  assert.equal(FREE_ALLOWANCES.r2.requiresExplicitActivation, true);
  assert.equal(
    catalog.find(item => item.id === 'r2').platformOwnedDistinctResource,
    'platform_zip_staging_r2_is_not_customer_bucket'
  );
  assert.equal(
    catalog.find(item => item.id === 'd1').platformOwnedDistinctResource,
    'platform_onboarding_d1_is_not_customer_form_storage'
  );
});

test('missing owner identity or stale plan evidence fail closed without resource creation', () => {
  assert.equal(assessExtensionEligibility({}, { now }).state, 'not_available');
  assert.equal(assessExtensionEligibility({
    owner: owner({ githubUserId: 0 })
  }, { now }).createResources, false);

  const stale = assessExtensionEligibility({
    owner: owner(),
    planEvidence: plan({ expiresAt: now }),
    consent: true
  }, { now });
  assert.equal(stale.state, 'manual_setup');
  assert.equal(stale.reason, 'fresh_plan_evidence_required');
  assert.equal(stale.createResources, false);
  assert.match(stale.usageDashboardUrl, new RegExp(account));

  const drift = assessExtensionEligibility({
    owner: owner(),
    planEvidence: plan({ cloudflareAccountId: 'b'.repeat(32) }),
    consent: true
  }, { now });
  assert.equal(drift.state, 'manual_setup');
  assert.equal(drift.createResources, false);
});

test('consent and R2 activation gates keep capability states honest', () => {
  const awaitingConsent = assessExtensionEligibility({
    owner: owner(),
    planEvidence: plan(),
    consent: false
  }, { now });
  assert.equal(awaitingConsent.state, 'available_opt_in');
  assert.equal(awaitingConsent.extensions.r2.state, 'available_opt_in');
  assert.equal(awaitingConsent.createResources, false);
  assert.equal(awaitingConsent.staticSiteRemainsAvailable, true);
  assert(Object.values(awaitingConsent.extensions).every(item =>
    TOOLKIT_CAPABILITY_STATES.includes(item.state)));

  const withConsent = assessExtensionEligibility({
    owner: owner(),
    planEvidence: plan(),
    consent: true
  }, { now });
  assert.equal(withConsent.extensions.pages_functions.state, 'available_opt_in');
  assert.equal(withConsent.extensions.d1.state, 'available_opt_in');
  assert.equal(withConsent.extensions.kv.state, 'available_opt_in');
  assert.equal(withConsent.extensions.r2.state, 'blocked_permission_or_plan');
  assert.equal(withConsent.extensions.r2.reason, 'r2_subscription_activation_required');
  assert.match(withConsent.extensions.r2.activationUrl, /\/r2\/overview$/);

  const r2Ready = assessExtensionEligibility({
    owner: owner(),
    planEvidence: plan({ r2Activated: true }),
    consent: true
  }, { now });
  assert.equal(r2Ready.extensions.r2.state, 'available_opt_in');
  assert.equal(r2Ready.platformZipR2Distinct, true);
});

test('review plans bind a digest and never authorize resource creation', () => {
  const blockedR2 = buildExtensionReviewPlan({
    owner: owner(),
    planEvidence: plan({ r2Activated: false }),
    consent: true,
    selectedExtensions: ['r2'],
    expectedMonthlyUsage: { summary: 'About 2 GB media uploads per month' },
    retentionDays: 30
  }, { now });
  assert.equal(blockedR2.status, 'blocked');
  assert.equal(blockedR2.reason, 'r2_subscription_activation_required');
  assert.equal(blockedR2.approvalDigest, null);
  assert.equal(blockedR2.createResources, false);

  const planResult = buildExtensionReviewPlan({
    owner: owner(),
    planEvidence: plan({ r2Activated: true }),
    consent: true,
    selectedExtensions: ['kv', 'd1'],
    expectedMonthlyUsage: { summary: 'Contact form drafts under 10k writes/month' },
    retentionDays: 30
  }, { now });
  assert.equal(planResult.status, 'review_only');
  assert.equal(planResult.createResources, false);
  assert.equal(planResult.plan.selectedExtensions.join(','), 'd1,kv');
  assert.equal(planResult.plan.platformZipR2Distinct, true);
  assert.equal(planResult.plan.billingActivation, 'not_required');
  assert.match(planResult.approvalDigest, /^[a-f0-9]{64}$/);
  assert(planResult.notices.some(text => /Static Pages hosting stays available/.test(text)));

  // Digest must change when usage summary or selection changes.
  const altered = buildExtensionReviewPlan({
    owner: owner(),
    planEvidence: plan({ r2Activated: true }),
    consent: true,
    selectedExtensions: ['kv', 'd1'],
    expectedMonthlyUsage: { summary: 'Different expected usage summary text' },
    retentionDays: 30
  }, { now });
  assert.notEqual(altered.approvalDigest, planResult.approvalDigest);

  for (const bad of [
    { selectedExtensions: ['workers'] },
    { selectedExtensions: ['d1', 'd1'] },
    { selectedExtensions: [] },
    { expectedMonthlyUsage: { summary: 'short' } },
    { retentionDays: 0 },
    { retentionDays: 400 },
    { consent: false }
  ]) {
    const result = buildExtensionReviewPlan({
      owner: owner(),
      planEvidence: plan({ r2Activated: true }),
      consent: true,
      selectedExtensions: ['d1'],
      expectedMonthlyUsage: { summary: 'Valid monthly usage summary text' },
      retentionDays: 30,
      ...bad
    }, { now });
    assert.equal(result.status, 'blocked');
    assert.equal(result.createResources, false);
    assert.equal(result.approvalDigest, null);
  }
});

test('budget pause keeps the static site available and never creates resources', () => {
  const paused = projectBudgetPause({
    owner: owner(),
    extension: 'pages_functions',
    providerDenial: true
  });
  assert.equal(paused.state, 'blocked_permission_or_plan');
  assert.equal(paused.extensionPaused, true);
  assert.equal(paused.staticSiteRemainsAvailable, true);
  assert.equal(paused.createResources, false);
  assert.equal(paused.reason, 'provider_denied_or_quota_exhausted');

  assert.equal(projectBudgetPause({
    owner: owner({ repositoryName: 'not-managed' }),
    extension: 'kv'
  }).state, 'not_available');
});

test('approval digests are stable canonical SHA-256 over the frozen plan body', () => {
  const result = buildExtensionReviewPlan({
    owner: owner(),
    planEvidence: plan({ workersPlan: 'workers_paid', r2Activated: true }),
    consent: true,
    selectedExtensions: ['r2'],
    expectedMonthlyUsage: { summary: 'Optional media uploads under 5 GB-month' },
    retentionDays: 14
  }, { now });
  assert.equal(result.plan.billingActivation, 'owner_confirmed_r2_activated');
  const recomputed = createHash('sha256').update((() => {
    const value = result.plan;
    const stable = v => {
      if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
      if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map(key =>
          JSON.stringify(key) + ':' + stable(v[key])).join(',') + '}';
      }
      return JSON.stringify(v);
    };
    return stable(value);
  })(), 'utf8').digest('hex');
  assert.equal(result.approvalDigest, recomputed);
});
