// Digest-bound opt-in reviews for Web Analytics and PR previews (#85 / #86).
// Store-only. Never enables a beacon or changes preview_deployment_setting.
import { createHash } from 'node:crypto';
import { UPDATE_BRANCH_PATTERN, previewExposureNotice } from './pages-preview-policy.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const PROJECT = /^(esp-[a-z0-9]+(?:-[a-z0-9]+)*)-site$/;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(plan) {
  return createHash('sha256').update(stableJson(plan), 'utf8').digest('hex');
}

function ownerOk(githubUserId, cloudflareAccountId, pagesProjectName) {
  return Number.isSafeInteger(githubUserId) && githubUserId > 0 &&
    typeof cloudflareAccountId === 'string' && ACCOUNT.test(cloudflareAccountId) &&
    typeof pagesProjectName === 'string' && PROJECT.test(pagesProjectName);
}

/** Owner asks to review enabling Pages Web Analytics later. Does not activate. */
export function buildAnalyticsOptInReview({
  githubUserId, cloudflareAccountId, pagesProjectName, analyticsConsent
} = {}) {
  if (!ownerOk(githubUserId, cloudflareAccountId, pagesProjectName))
    return Object.freeze({
      status: 'blocked', reason: 'verified_owner_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (analyticsConsent !== true)
    return Object.freeze({
      status: 'blocked', reason: 'analytics_owner_consent_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const plan = Object.freeze({
    kind: 'launch-and-own-analytics-opt-in',
    version: 1,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    pagesProjectName,
    proposed: Object.freeze({ feature: 'cloudflare_web_analytics', activation: 'manual_or_later_apply' }),
    notices: Object.freeze([
      'This request does not enable Web Analytics or inject a beacon.',
      'A later apply may change Pages Metrics settings on this project only.',
      'Review Cloudflare Pages → Metrics → Web Analytics before activation.'
    ]),
    canActivate: false,
    canWrite: false
  });
  return Object.freeze({
    status: 'awaiting_analytics_opt_in',
    plan,
    approvalDigest: digest(plan),
    canActivate: false,
    canWrite: false
  });
}

/**
 * Owner asks to review scoped PR preview builds later.
 * Requires acknowledging that draft preview URLs can be public.
 */
export function buildPreviewOptInReview({
  githubUserId, cloudflareAccountId, pagesProjectName, previewConsent, acknowledgePublicPreviews
} = {}) {
  if (!ownerOk(githubUserId, cloudflareAccountId, pagesProjectName))
    return Object.freeze({
      status: 'blocked', reason: 'verified_owner_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (previewConsent !== true)
    return Object.freeze({
      status: 'blocked', reason: 'preview_owner_consent_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (acknowledgePublicPreviews !== true)
    return Object.freeze({
      status: 'blocked', reason: 'public_preview_acknowledgement_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const plan = Object.freeze({
    kind: 'launch-and-own-preview-opt-in',
    version: 1,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    pagesProjectName,
    proposed: Object.freeze({
      preview_deployment_setting: 'custom',
      preview_branch_includes: Object.freeze([UPDATE_BRANCH_PATTERN]),
      preview_branch_excludes: Object.freeze(['main']),
      pr_comments_enabled: false
    }),
    notices: Object.freeze(previewExposureNotice()),
    canActivate: false,
    canWrite: false,
    accessPolicyRequired: true
  });
  return Object.freeze({
    status: 'awaiting_preview_opt_in',
    plan,
    approvalDigest: digest(plan),
    canActivate: false,
    canWrite: false
  });
}
