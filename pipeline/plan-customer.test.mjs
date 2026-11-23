import test from 'node:test';
import assert from 'node:assert/strict';
import { planCustomer, slugify, TURNSTILE_FREE_LIMITS } from './plan-customer.mjs';

const base = {
  name: 'Second Customer',
  accountId: '0123456789abcdef0123456789abcdef',
  githubOwner: 'example-owner'
};

test('website-only plan is default and does not create forms', () => {
  const p = planCustomer(base);
  assert.equal(p.mode, 'plan-only');
  assert.equal(p.forms, false);
  assert.equal(p.formsReview, null);
  assert.equal(p.workingForm, false);
  assert.equal(p.canActivate, false);
  assert.deepEqual(p.steps.map(s => s.id), ['github', 'pages', 'deploy']);
  assert.equal(p.domain, 'esp-second-customer-site.pages.dev');
});

test('forms opt-in keeps the step DAG and attaches Siteverify review only after consent', () => {
  const blocked = planCustomer({ ...base, forms: true, ownerEmail: 'owner@example.com' });
  assert.deepEqual(blocked.steps.map(s => s.id),
    ['github', 'pages', 'deploy', 'd1', 'turnstile', 'worker', 'access', 'form-deploy', 'acceptance']);
  assert.equal(blocked.formsReview.status, 'blocked');
  assert.equal(blocked.formsReview.reason, 'owner_form_consent_required');
  assert.equal(blocked.formsReview.workingForm, false);
  assert.equal(blocked.formsReview.approvalDigest, null);

  const p = planCustomer({
    ...base,
    forms: true,
    formsConsent: true,
    ownerEmail: 'owner@example.com'
  });
  assert.deepEqual(p.steps.find(s => s.id === 'worker').requires, ['d1', 'turnstile']);
  assert.equal(p.steps.find(s => s.id === 'turnstile').gate, 'server-side-siteverify-required');
  assert.equal(p.steps.find(s => s.id === 'd1').gate, 'issue-89-cost-privacy-review');
  assert.equal(p.formsReview.siteverify.required, true);
  assert.equal(p.formsReview.siteverify.url, TURNSTILE_FREE_LIMITS.siteverifyUrl);
  assert.equal(p.formsReview.workingForm, false);
  assert.equal(p.formsReview.canActivate, false);
  assert.equal(p.formsReview.canWrite, false);
  assert.equal(p.formsReview.createResources, false);
  assert.equal(p.formsReview.storageGate.relatedIssue, '#89');
  assert.match(p.formsReview.approvalDigest, /^[a-f0-9]{64}$/);
  assert(p.safeguards.some(text => /Siteverify/.test(text)));
});

test('plans are deterministic', () => assert.deepEqual(planCustomer(base), planCustomer(base)));

test('rejects malformed input and missing consent prerequisites', () => {
  for (const input of [
    null,
    {},
    { ...base, forms: true },
    { ...base, forms: true, formsConsent: true },
    { ...base, forms: 'yes' },
    { ...base, formsConsent: 'yes' },
    { ...base, accountId: 'wrong' },
    { ...base, githubOwner: 'bad/owner' },
    { ...base, hostname: 'bad host' },
    { ...base, hostname: 'localhost' },
    { ...base, name: '!!!' }
  ]) assert.throws(() => planCustomer(input));
});

test('safe names', () => assert.equal(slugify('  My & New Site! '), 'my-new-site'));
