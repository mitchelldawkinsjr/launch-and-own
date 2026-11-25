import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyticsOptInReview, buildPreviewOptInReview,
  buildSeoOptInReview, buildRedirectOptInReview
} from './option-feature-review.mjs';
import { UPDATE_BRANCH_PATTERN } from './pages-preview-policy.mjs';

const base = {
  githubUserId: 42,
  cloudflareAccountId: 'a'.repeat(32),
  pagesProjectName: 'esp-willow-studio-site'
};

test('analytics opt-in stays inactive until consent and never authorizes writes', () => {
  assert.equal(buildAnalyticsOptInReview({ ...base, analyticsConsent: false }).reason,
    'analytics_owner_consent_required');
  const review = buildAnalyticsOptInReview({ ...base, analyticsConsent: true });
  assert.equal(review.status, 'awaiting_analytics_opt_in');
  assert.equal(review.canActivate, false);
  assert.equal(review.canWrite, false);
  assert.match(review.approvalDigest, /^[a-f0-9]{64}$/);
  assert.equal(review.plan.kind, 'launch-and-own-analytics-opt-in');
});

test('preview opt-in requires public-preview acknowledgement and stays inactive', () => {
  assert.equal(buildPreviewOptInReview({
    ...base, previewConsent: true, acknowledgePublicPreviews: false
  }).reason, 'public_preview_acknowledgement_required');
  const review = buildPreviewOptInReview({
    ...base, previewConsent: true, acknowledgePublicPreviews: true
  });
  assert.equal(review.status, 'awaiting_preview_opt_in');
  assert.equal(review.canActivate, false);
  assert.equal(review.plan.proposed.preview_deployment_setting, 'custom');
  assert.deepEqual(review.plan.proposed.preview_branch_includes, [UPDATE_BRANCH_PATTERN]);
  assert.equal(review.plan.accessPolicyRequired, true);
});

test('SEO opt-in stays inactive and never claims a Git write', () => {
  assert.equal(buildSeoOptInReview({...base, seoConsent: false}).reason,
    'seo_owner_consent_required');
  const review = buildSeoOptInReview({...base, seoConsent: true});
  assert.equal(review.status, 'awaiting_seo_opt_in');
  assert.equal(review.canActivate, false);
  assert.equal(review.canWrite, false);
  assert.equal(review.plan.proposed.activation, 'owner_reviewed_git_pr_later');
  assert.match(review.approvalDigest, /^[a-f0-9]{64}$/);
});

test('redirect opt-in requires same-host rules and never claims Page Rules', () => {
  assert.equal(buildRedirectOptInReview({
    githubUserId: 42, cloudflareAccountId: 'a'.repeat(32),
    hostname: 'www.example.com', redirectConsent: true, wwwMode: 'none'
  }).reason, 'redirect_rule_required');
  assert.equal(buildRedirectOptInReview({
    githubUserId: 42, cloudflareAccountId: 'a'.repeat(32),
    hostname: 'www.example.com', redirectConsent: true,
    wwwMode: 'none', pathFrom: '/a', pathTo: 'https://evil.example/'
  }).reason, 'redirects_must_stay_on_the_same_host');
  const review = buildRedirectOptInReview({
    githubUserId: 42, cloudflareAccountId: 'a'.repeat(32),
    hostname: 'www.example.com', redirectConsent: true,
    wwwMode: 'apex_to_www', pathFrom: '/old', pathTo: '/new'
  });
  assert.equal(review.status, 'awaiting_redirect_opt_in');
  assert.equal(review.canWrite, false);
  assert.equal(review.plan.proposed.premiumWafIncluded, false);
  assert.equal(review.plan.proposed.pathRules[0].status, 301);
});
