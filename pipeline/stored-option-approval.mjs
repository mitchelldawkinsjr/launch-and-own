// #88 / Agent 2: read *actual* 0005 stored review JSON, without granting execution.
// This is intentionally pure: a "stored" row is not an authorized provider action.
import { buildDomainApprovalReview } from './domain-approval-review.mjs';
import { planCustomer } from './plan-customer.mjs';
import { buildEmailRoutingApprovalReview } from './approved-extension-consumer.mjs';
import {
  buildAnalyticsOptInReview, buildPreviewOptInReview,
  buildSeoOptInReview, buildRedirectOptInReview
} from './option-feature-review.mjs';

const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const TYPES = new Set([
  'domain', 'email', 'forms', 'analytics', 'pr_previews', 'seo', 'redirects'
]);
const deny = message => {throw new StoredOptionApprovalError(message);};

export class StoredOptionApprovalError extends Error {
  constructor(code) {
    super('Stored post-launch option cannot be consumed (' + code + ')');
    this.name = 'StoredOptionApprovalError';
    this.code = code;
  }
}

function json(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384)
    deny('invalid_payload');
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) deny('invalid_payload');
    return parsed;
  } catch { deny('invalid_payload'); }
}
function sameReview(payload, recomputed) {
  // Exact serialized shape prevents augmenting a request with fields that its
  // review digest never covered (including attacker-provided mail destinations).
  return payload && recomputed &&
    JSON.stringify(payload) === JSON.stringify(recomputed) &&
    payload.approvalDigest === recomputed.approvalDigest;
}

/**
 * Normalizes the ACTUAL Agent 1 #118 schema; never turns "stored" into "approved".
 * The caller must independently read current live job/owner account from D1
 * and confirm both OAuth grants and the current GitHub+Pages resource identity.
 *
 * A separate operator-approved execution record with a CAS lease is required
 * before the returned normalizedPayload can be used for provider operations.
 */
export function validateStoredOptionApproval(raw, {
  jobId, githubUserId, githubLogin, cloudflareAccountId, customerName,
  pagesProjectName
} = {}) {
  if (!raw || !ID.test(raw.id || '') || !ID.test(raw.job_id || '') ||
      raw.job_id !== jobId || !Number.isSafeInteger(githubUserId) || githubUserId <= 0 ||
      raw.github_user_id !== githubUserId || !ACCOUNT.test(cloudflareAccountId || '') ||
      raw.cloudflare_account_id !== cloudflareAccountId ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubLogin || '') ||
      typeof customerName !== 'string' || !customerName.trim() ||
      typeof pagesProjectName !== 'string' ||
      !/^(esp-[a-z0-9]+(?:-[a-z0-9]+)*)-site$/.test(pagesProjectName) ||
      !TYPES.has(raw.kind) || !DIGEST.test(raw.approval_digest || '') ||
      raw.status !== 'stored')
    deny('owned_stored_row_required');
  const payload = json(raw.payload_json);
  let expected, normalized;
  try {
    if (raw.kind === 'domain') {
      const host = payload?.plan?.hostname;
      expected = buildDomainApprovalReview({
        githubUserId, cloudflareAccountId, hostname: host, domainConsent: true
      });
      if (expected.status !== 'awaiting_domain_approval') deny('invalid_domain_review');
      normalized = {hostname: expected.plan.hostname};
    } else if (raw.kind === 'email') {
      // Email rows must use buildEmailRoutingApprovalReview so the mailbox is
      // bound into the digest. Older domain-planner payloads fail closed.
      if (payload?.plan?.kind !== 'launch-and-own-email-routing-approval')
        deny('mailbox_not_bound_to_stored_digest');
      expected = buildEmailRoutingApprovalReview({
        githubUserId, cloudflareAccountId,
        hostname: payload.plan.hostname, mailbox: payload.plan.mailbox
      });
      normalized = {
        hostname: expected.plan.hostname, mailbox: expected.plan.mailbox
      };
    } else if (raw.kind === 'forms') {
      expected = planCustomer({
        name: customerName, accountId: cloudflareAccountId,
        githubOwner: githubLogin, forms: true, formsConsent: true,
        ownerEmail: payload.ownerEmail
      }).formsReview;
      if (expected.domain !== pagesProjectName + '.pages.dev')
        deny('forms_site_mismatch');
      normalized = {
        hostname: expected.domain,
        name: customerName,
        ownerEmail: expected.ownerEmail
      };
    } else if (raw.kind === 'analytics') {
      expected = buildAnalyticsOptInReview({
        githubUserId, cloudflareAccountId, pagesProjectName, analyticsConsent: true
      });
      if (expected.status !== 'awaiting_analytics_opt_in') deny('invalid_analytics_review');
      normalized = { pagesProjectName: expected.plan.pagesProjectName, feature: 'cloudflare_web_analytics' };
    } else if (raw.kind === 'pr_previews') {
      expected = buildPreviewOptInReview({
        githubUserId, cloudflareAccountId, pagesProjectName,
        previewConsent: true, acknowledgePublicPreviews: true
      });
      if (expected.status !== 'awaiting_preview_opt_in') deny('invalid_preview_review');
      normalized = {
        pagesProjectName: expected.plan.pagesProjectName,
        preview_deployment_setting: expected.plan.proposed.preview_deployment_setting,
        accessPolicyRequired: true
      };
    } else if (raw.kind === 'seo') {
      expected = buildSeoOptInReview({
        githubUserId, cloudflareAccountId, pagesProjectName, seoConsent: true
      });
      if (expected.status !== 'awaiting_seo_opt_in') deny('invalid_seo_review');
      normalized = {
        pagesProjectName: expected.plan.pagesProjectName,
        feature: 'static_seo_starter'
      };
    } else if (raw.kind === 'redirects') {
      expected = buildRedirectOptInReview({
        githubUserId, cloudflareAccountId,
        hostname: payload?.plan?.hostname,
        redirectConsent: true,
        wwwMode: payload?.plan?.proposed?.wwwMode || 'none',
        pathFrom: payload?.plan?.proposed?.pathRules?.[0]?.from || '',
        pathTo: payload?.plan?.proposed?.pathRules?.[0]?.to || ''
      });
      if (expected.status !== 'awaiting_redirect_opt_in') deny('invalid_redirect_review');
      normalized = {
        hostname: expected.plan.hostname,
        wwwMode: expected.plan.proposed.wwwMode,
        pathRules: expected.plan.proposed.pathRules
      };
    } else {
      deny('owned_stored_row_required');
    }
  } catch (error) {
    if (error instanceof StoredOptionApprovalError) throw error;
    deny('invalid_review_payload');
  }
  if (!sameReview(payload, expected) ||
      raw.approval_digest.toLowerCase() !== expected.approvalDigest)
    deny('review_digest_or_payload_mismatch');
  return Object.freeze({
    id: raw.id, jobId, githubUserId, cloudflareAccountId, kind: raw.kind,
    digest: expected.approvalDigest, storedPayloadJson: raw.payload_json,
    normalizedPayload: Object.freeze(normalized), status: 'stored',
    requiresSeparateExecutionAuthorization: true, canWrite: false,
    canActivate: false
  });
}
