import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainApprovalReview } from './domain-approval-review.mjs';
import { planCustomer } from './plan-customer.mjs';
import { buildEmailRoutingApprovalReview } from './approved-extension-consumer.mjs';
import { validateStoredOptionApproval, StoredOptionApprovalError } from './stored-option-approval.mjs';

const account = 'a'.repeat(32);
const id = '12345678-1234-4234-8234-123456789abc';
const jobId = '87654321-4321-4321-8321-cba987654321';
const owner = Object.freeze({
  jobId, githubUserId: 42, githubLogin: 'siteowner',
  cloudflareAccountId: account, customerName: 'Fern',
  pagesProjectName: 'esp-fern-site'
});
function stored(kind, review) {
  return {
    id, job_id: jobId, github_user_id: 42,
    cloudflare_account_id: account, kind, status: 'stored',
    approval_digest: review.approvalDigest,
    payload_json: JSON.stringify(review)
  };
}
const domainReview = () => buildDomainApprovalReview({
  githubUserId: 42, cloudflareAccountId: account,
  hostname: 'www.example.com', domainConsent: true
});
const oldEmailReview = () => buildDomainApprovalReview({
  githubUserId: 42, cloudflareAccountId: account,
  hostname: 'www.example.com', mailbox: 'forward@example.net', domainConsent: true
});
const emailReview = () => buildEmailRoutingApprovalReview({
  githubUserId: 42, cloudflareAccountId: account,
  hostname: 'www.example.com', mailbox: 'forward@example.net'
});
const formsReview = () => planCustomer({
  name: 'Fern', accountId: account, githubOwner: 'siteowner',
  forms: true, formsConsent: true, ownerEmail: 'owner@example.net'
}).formsReview;

function rejects(row, code, ctx = owner) {
  assert.throws(() => validateStoredOptionApproval(row, ctx),
    error => error instanceof StoredOptionApprovalError && error.code === code);
}
test('actual #118 domain stored review can be verified but cannot authorize writes', () => {
  const checked = validateStoredOptionApproval(stored('domain', domainReview()), owner);
  assert.equal(checked.normalizedPayload.hostname, 'www.example.com');
  assert.equal(checked.status, 'stored');
  assert.equal(checked.canWrite, false);
  assert.equal(checked.requiresSeparateExecutionAuthorization, true);
});

test('actual #118 forms review is tied to customer original pages.dev host', () => {
  const checked = validateStoredOptionApproval(stored('forms', formsReview()), owner);
  assert.equal(checked.normalizedPayload.hostname, 'esp-fern-site.pages.dev');
  assert.equal(checked.normalizedPayload.ownerEmail, 'owner@example.net');
  assert.equal(checked.canActivate, false);
});

test('actual #118 email row is unsafe: stored digest omitted destination and always denies', () => {
  const legacy = oldEmailReview();
  assert.equal(legacy.approvalDigest, buildDomainApprovalReview({
    githubUserId: 42, cloudflareAccountId: account, hostname: 'www.example.com',
    mailbox: 'someone-else@example.net', domainConsent: true
  }).approvalDigest);
  rejects(stored('email', legacy), 'mailbox_not_bound_to_stored_digest');
});

test('corrected email review includes a pinned forwarding recipient yet stays unexecutable', () => {
  const review = emailReview();
  const checked = validateStoredOptionApproval(stored('email', review), owner);
  assert.equal(checked.normalizedPayload.mailbox, 'forward@example.net');
  assert.equal(checked.status, 'stored');
  assert.equal(checked.canWrite, false);
});

test('a changed mailbox, host, added field, or altered digest is rejected', () => {
  const base = stored('email', emailReview());
  for (const changed of [
    {plan: {...emailReview().plan, mailbox: 'attacker@example.net'}},
    {plan: {...emailReview().plan, hostname: 'attacker.example.com'}},
    {extra: 'new-mailbox'},
    {plan: {...emailReview().plan, sendingMailbox: true}}
  ]) {
    const body = {...emailReview(), ...changed};
    rejects({...base, payload_json: JSON.stringify(body)}, 'review_digest_or_payload_mismatch');
  }
  rejects({...base, approval_digest: 'f'.repeat(64)}, 'review_digest_or_payload_mismatch');
});

test('cross tenant, stale launch id, status applying, and wrong site fail before write', () => {
  const row = stored('domain', domainReview());
  for (const changed of [
    {github_user_id: 66},
    {cloudflare_account_id: 'b'.repeat(32)},
    {job_id: id},
    {status: 'approved'}
  ]) rejects({...row, ...changed}, 'owned_stored_row_required');
  rejects(row, 'owned_stored_row_required', {...owner, githubUserId: 77});
  rejects(stored('forms', formsReview()), 'forms_site_mismatch',
    {...owner, pagesProjectName: 'esp-other-site'});
});

test('forms digest cannot be repurposed to a new recipient', () => {
  const row = stored('forms', formsReview());
  rejects({...row, payload_json: JSON.stringify({
    ...formsReview(), ownerEmail: 'attacker@example.net'
  })}, 'review_digest_or_payload_mismatch');
});

test('a forged plan that copies the original digest cannot append an extra redirect', () => {
  const row = stored('domain', domainReview());
  rejects({...row, payload_json: JSON.stringify({
    ...domainReview(), plan: {
      ...domainReview().plan,
      capabilities: {
        ...domainReview().plan.capabilities,
        redirects: {
          ...domainReview().plan.capabilities.redirects,
          rules: [{from: '/one', to: '/two', status: 301}]
        }
      }
    }
  })}, 'review_digest_or_payload_mismatch');
});
