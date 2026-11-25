import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TURNSTILE_FREE_LIMITS,
  buildTurnstileFormReviewPlan,
  projectContactFormsCapability
} from './turnstile-form-review.mjs';
import { planCustomer } from './plan-customer.mjs';
import { TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';

const account = '0123456789abcdef0123456789abcdef';

function ownerInput(overrides = {}) {
  return {
    owner: {
      githubUserId: 10,
      githubLogin: 'example-owner',
      cloudflareAccountId: account,
      siteId: 'site_fixture',
      pagesProjectId: 'project-fixture',
      repositoryId: 42,
      repositoryName: 'esp-second-customer',
      branch: 'main'
    },
    consent: true,
    ownerEmail: 'owner@example.com',
    hostname: 'www.example.com',
    ...overrides
  };
}

test('adapter reuses planCustomer forms steps and Free Turnstile limits', () => {
  assert.equal(TURNSTILE_FREE_LIMITS.widgetsPerAccount, 20);
  const result = buildTurnstileFormReviewPlan(ownerInput());
  assert.equal(result.status, 'review_only');
  assert.equal(result.canActivate, false);
  assert.equal(result.workingForm, false);
  assert.equal(result.plan.siteverify.required, true);
  assert.deepEqual(result.provisioningSteps.map(step => step.id),
    ['d1', 'turnstile', 'worker', 'access', 'form-deploy', 'acceptance']);
  const direct = planCustomer({
    name: 'esp-second-customer',
    accountId: account,
    githubOwner: 'example-owner',
    forms: true,
    formsConsent: true,
    ownerEmail: 'owner@example.com',
    hostname: 'www.example.com'
  });
  assert.equal(result.approvalDigest, direct.formsReview.approvalDigest);
});

test('missing consent or identity fail closed through the shared planner', () => {
  assert.equal(buildTurnstileFormReviewPlan(ownerInput({ consent: false })).reason,
    'owner_form_consent_required');
  assert.equal(buildTurnstileFormReviewPlan(ownerInput({ ownerEmail: undefined })).reason,
    'owner_email_required_for_forms');
  assert.equal(buildTurnstileFormReviewPlan(ownerInput({ hostname: 'localhost' })).reason,
    'authorized_hostname_required');
  assert.equal(buildTurnstileFormReviewPlan({}).state, 'not_available');
});

test('contact_forms projector never reports an enabled form', () => {
  const fromAdapter = projectContactFormsCapability(buildTurnstileFormReviewPlan(ownerInput()));
  assert.equal(fromAdapter.feature, 'contact_forms');
  assert.equal(fromAdapter.state, 'available_opt_in');
  assert.equal(fromAdapter.workingForm, false);
  assert(TOOLKIT_CAPABILITY_STATES.includes(fromAdapter.state));

  const fromPlan = projectContactFormsCapability(planCustomer({
    name: 'Second Customer',
    accountId: account,
    githubOwner: 'example-owner',
    forms: true,
    formsConsent: true,
    ownerEmail: 'owner@example.com'
  }));
  assert.equal(fromPlan.workingForm, false);
  assert.equal(fromPlan.canActivate, false);
  assert.equal(projectContactFormsCapability(null).state, 'not_available');
});
