import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyticsOptInReview, buildPreviewOptInReview
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
