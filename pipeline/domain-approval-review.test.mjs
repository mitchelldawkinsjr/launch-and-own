import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDomainApprovalReview } from './domain-approval-review.mjs';

const account = 'a'.repeat(32);
const base = {
  cloudflareAccountId: account,
  githubUserId: 10,
  hostname: 'www.example.com',
  domainConsent: true
};

test('without owner consent the review does not authorize DNS or mail writes', () => {
  const result = buildDomainApprovalReview({ ...base, domainConsent: false });
  assert.equal(result.state, 'available_opt_in');
  assert.equal(result.dnsWriteAuthorized, false);
  assert.equal(result.mxWriteAuthorized, false);
  assert.equal(result.approvalDigest, null);
});

test('a consented custom hostname stays manual until Domain approves a write', () => {
  const result = buildDomainApprovalReview(base);
  assert.equal(result.status, 'awaiting_domain_approval');
  assert.equal(result.plan.capabilities.custom_domains.state, 'manual_setup');
  assert.equal(result.plan.registrarIncluded, false);
  assert.equal(result.plan.capabilities.email_routing.state, 'not_available');
  assert.equal(result.dnsWriteAuthorized, false);
  assert.equal(result.nameserverChangeAuthorized, false);
  assert.match(result.approvalDigest, /^[a-f0-9]{64}$/);
  for (const host of ['localhost', 'shop.pages.dev', 'https://example.com/path', 'bad host']) {
    assert.equal(buildDomainApprovalReview({ ...base, hostname: host }).status, 'blocked');
  }
});

test('email forwarding and redirects stay on-host and never authorize MX changes', () => {
  const blocked = buildDomainApprovalReview({ ...base, mailbox: 'owner@www.example.com' });
  assert.equal(blocked.reason, 'forward_to_an_existing_external_mailbox');
  assert.equal(blocked.mxWriteAuthorized, false);

  const review = buildDomainApprovalReview({
    ...base,
    mailbox: 'owner@elsewhere.com',
    redirects: [{ from: '/old', to: '/new' }]
  });
  assert.equal(review.plan.capabilities.email_routing.state, 'manual_setup');
  assert.equal(review.plan.capabilities.email_routing.sendingMailbox, false);
  assert.equal(review.plan.capabilities.redirects.rules.length, 1);
  assert.equal(review.mxWriteAuthorized, false);
  assert.equal(buildDomainApprovalReview({
    ...base,
    redirects: [{ from: '/old', to: 'https://evil.example/phish' }]
  }).reason, 'redirects_must_stay_on_the_same_host');
});
