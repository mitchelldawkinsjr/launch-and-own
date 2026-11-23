import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  TURNSTILE_FREE_LIMITS,
  buildTurnstileFormReviewPlan,
  projectContactFormsCapability
} from './turnstile-form-review.mjs';
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

function valid(overrides = {}) {
  return {
    owner: owner(),
    consent: true,
    hostname: 'www.example.com',
    deliveryTarget: 'owner-email-forward',
    retentionDays: 30,
    deletionPlan: 'time-bound',
    expectedAction: 'contact',
    rateLimitPerHour: 30,
    ...overrides
  };
}

test('Free Turnstile limits disclose widget and hostname caps and Siteverify URL', () => {
  assert.equal(TURNSTILE_FREE_LIMITS.widgetsPerAccount, 20);
  assert.equal(TURNSTILE_FREE_LIMITS.hostnamesPerWidget, 10);
  assert.equal(TURNSTILE_FREE_LIMITS.tokenTtlSeconds, 300);
  assert.match(TURNSTILE_FREE_LIMITS.siteverifyUrl, /siteverify$/);
});

test('review plans require owner consent, hostname, delivery, retention and rate limits', () => {
  assert.equal(buildTurnstileFormReviewPlan({}, { now }).state, 'not_available');
  assert.equal(buildTurnstileFormReviewPlan(valid({ consent: false }), { now }).reason,
    'owner_form_consent_required');
  assert.equal(buildTurnstileFormReviewPlan(valid({ hostname: 'https://evil.test/path' }), { now }).reason,
    'authorized_hostname_required');
  assert.equal(buildTurnstileFormReviewPlan(valid({ hostname: 'localhost' }), { now }).reason,
    'authorized_hostname_required');
  assert.equal(buildTurnstileFormReviewPlan(valid({ deliveryTarget: 'mailto-only' }), { now }).reason,
    'customer_owned_delivery_target_required');
  assert.equal(buildTurnstileFormReviewPlan(valid({ deliveryTarget: 'customer-owned-d1' }), { now }).reason,
    'form_storage_requires_separate_cost_and_privacy_review');
  assert.equal(buildTurnstileFormReviewPlan(valid({ retentionDays: 0 }), { now }).reason,
    'retention_and_deletion_required');
  assert.equal(buildTurnstileFormReviewPlan(valid({ expectedAction: 'Contact Form' }), { now }).reason,
    'exact_turnstile_action_required');
  assert.equal(buildTurnstileFormReviewPlan(valid({ rateLimitPerHour: 0 }), { now }).reason,
    'rate_limit_required');
});

test('a successful review plan never claims a working form and requires Siteverify', () => {
  const result = buildTurnstileFormReviewPlan(valid(), { now });
  assert.equal(result.status, 'review_only');
  assert.equal(result.state, 'available_opt_in');
  assert.equal(result.canActivate, false);
  assert.equal(result.canWrite, false);
  assert.equal(result.workingForm, false);
  assert.equal(result.widgetAloneInsufficient, true);
  assert.equal(result.plan.siteverify.required, true);
  assert.equal(result.plan.siteverify.singleUse, true);
  assert.equal(result.plan.hostname, 'www.example.com');
  assert.match(result.approvalDigest, /^[a-f0-9]{64}$/);
  assert(result.plan.notices.some(text => /Siteverify/.test(text)));

  const altered = buildTurnstileFormReviewPlan(valid({ expectedAction: 'support' }), { now });
  assert.notEqual(altered.approvalDigest, result.approvalDigest);

  const stable = value => {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key =>
        JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  };
  assert.equal(result.approvalDigest,
    createHash('sha256').update(stable(result.plan), 'utf8').digest('hex'));
});

test('contact_forms projector never reports an enabled form from a widget-only review', () => {
  const ready = projectContactFormsCapability(buildTurnstileFormReviewPlan(valid(), { now }));
  assert.equal(ready.feature, 'contact_forms');
  assert.equal(ready.state, 'available_opt_in');
  assert.equal(ready.workingForm, false);
  assert.equal(ready.canActivate, false);
  assert(TOOLKIT_CAPABILITY_STATES.includes(ready.state));

  const blocked = projectContactFormsCapability(buildTurnstileFormReviewPlan(valid({
    deliveryTarget: 'customer-owned-d1'
  }), { now }));
  assert.equal(blocked.state, 'blocked_permission_or_plan');
  assert.equal(blocked.workingForm, false);

  assert.equal(projectContactFormsCapability(null).state, 'not_available');
});
