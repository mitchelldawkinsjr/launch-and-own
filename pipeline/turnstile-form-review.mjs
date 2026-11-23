// Review-only contact forms for a verified owner, site and delivery target (#88).
import {createHash} from 'node:crypto';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const GIT_SHA = /^[a-f0-9]{40}$/i;
const SITE_ID = /^[a-z0-9_-]{1,128}$/i;
const DESTINATION_ID = /^delivery_[a-zA-Z0-9_-]{8,119}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EVIDENCE_LIFETIME_SECONDS = 15 * 60;
const DELIVERY = new Set(['owner-email-forward', 'customer-owned-webhook']);
export const TURNSTILE_FREE_LIMITS = Object.freeze({
  widgetsPerAccount: 20,
  hostnamesPerWidget: 10,
  challenges: 'unlimited',
  tokenTtlSeconds: 300,
  siteverifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
});

const REVIEW_ONLY = Object.freeze({createResources:false, canActivate:false, canWrite:false, workingForm:false});
const matches = (pattern, text) => typeof text === 'string' && pattern.test(text);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function siteIdentity(owner) {
  if (!positiveInteger(owner?.githubUserId) || !positiveInteger(owner.repositoryId)
      || !matches(ACCOUNT, owner.cloudflareAccountId) || !matches(SITE_ID, owner.siteId)
      || !matches(SITE_ID, owner.pagesProjectId) || !matches(GIT_SHA, owner.baseCommitSha)
      || owner.productionBranch !== 'main')
    return null;
  return Object.freeze({
    githubUserId:owner.githubUserId, repositoryId:owner.repositoryId,
    cloudflareAccountId:owner.cloudflareAccountId, siteId:owner.siteId,
    pagesProjectId:owner.pagesProjectId, baseCommitSha:owner.baseCommitSha.toLowerCase()
  });
}

function productionHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim()) return null;
  const host = value.toLowerCase();
  if (!host.includes('.') || !host.split('.').every(label=>DNS_LABEL.test(label))
      || /^\d+(?:\.\d+){3}$/.test(host) || /\.(?:localhost|local|internal|invalid|test)$/.test(host))
    return null;
  return host;
}

function currentEvidence(evidence, kind, site, now) {
  return evidence?.kind === kind &&
    Object.keys(site).every(key=>evidence[key] === site[key]) &&
    positiveInteger(evidence.checkedAt) && evidence.checkedAt <= now &&
    positiveInteger(evidence.expiresAt) && evidence.expiresAt > now &&
    evidence.expiresAt - evidence.checkedAt <= EVIDENCE_LIFETIME_SECONDS;
}

function blocked(reason) {
  return Object.freeze({status:'blocked', state:'blocked_permission_or_plan', reason,
    plan:null, approvalDigest:null, freeLimits:TURNSTILE_FREE_LIMITS, ...REVIEW_ONLY});
}

/**
 * The owner, hostname evidence and delivery evidence are server-verified and
 * belong to the current authorized account and exact Git base. Consent here
 * expresses intent to review. A separate human approval and re-verification
 * of the destination, hostname, grants and costs are required for any action.
 * A delivery ID is an opaque reference to the verified target held by the
 * backend. Mail addresses, endpoint URLs, keys and tokens are never inputs.
 */
export function buildTurnstileFormReviewPlan({
  owner, consent, hostname, hostnameEvidence, deliveryTarget, deliveryEvidence,
  expectedAction, rateLimitPerHour, retentionDays, deletionPlan
} = {}, {now = Math.floor(Date.now()/1000)} = {}) {
  const identity = siteIdentity(owner);
  if (!identity || !positiveInteger(now)) return blocked('verified_owner_site_required');
  if (consent !== true) return blocked('owner_form_review_required');
  const host = productionHostname(hostname);
  if (!host || !currentEvidence(hostnameEvidence, 'verified-production-hostname', identity, now)
      || hostnameEvidence.hostname !== host)
    return blocked('verified_hostname_required');

  if (deliveryTarget === 'customer-owned-d1') return blocked('separate_cost_and_privacy_review_required');
  if (!DELIVERY.has(deliveryTarget)
      || !currentEvidence(deliveryEvidence, 'verified-contact-destination', identity, now)
      || deliveryEvidence.deliveryTarget !== deliveryTarget
      || !matches(DESTINATION_ID, deliveryEvidence.destinationId))
    return blocked('verified_delivery_reference_required');

  if (!positiveInteger(retentionDays) || retentionDays > 365 || deletionPlan !== 'time-bound')
    return blocked('bounded_personal_data_deletion_required');
  if (!matches(/^[a-zA-Z0-9_-]{1,32}$/, expectedAction)) return blocked('exact_turnstile_action_required');
  if (!positiveInteger(rateLimitPerHour) || rateLimitPerHour > 1000) return blocked('rate_limit_required');

  const plan = Object.freeze({
    kind:'launch-and-own-turnstile-form-review-v2',
    identity, hostname:host, hostnameVerifiedAt:hostnameEvidence.checkedAt,
    hostnameEvidenceExpiresAt:hostnameEvidence.expiresAt,
    delivery:Object.freeze({target:deliveryTarget, destinationId:deliveryEvidence.destinationId,
      verifiedAt:deliveryEvidence.checkedAt, evidenceExpiresAt:deliveryEvidence.expiresAt}),
    expectedAction, rateLimitPerHour, dataClassification:'personal', retentionDays, deletionPlan,
    issuedAt:now, expiresAt:Math.min(hostnameEvidence.expiresAt, deliveryEvidence.expiresAt),
    siteverify:Object.freeze({
      url:TURNSTILE_FREE_LIMITS.siteverifyUrl, tokenTtlSeconds:TURNSTILE_FREE_LIMITS.tokenTtlSeconds, singleUse:true,
      requireSuccess:true, requireMatchingHostname:true, requireMatchingAction:true,
      onError:'reject_submission'
    })
  });
  return Object.freeze({
    status:'review_only', state:'manual_setup', reason:'separate_owner_approval_and_server_siteverify_required',
    plan, approvalDigest:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    freeLimits:TURNSTILE_FREE_LIMITS, requiresSeparateHumanApproval:true, ...REVIEW_ONLY
  });
}

export function projectContactFormsCapability(review) {
  let state = 'not_available';
  let reason = 'form_review_required';
  if (review?.status === 'review_only' && review.state === 'manual_setup'
      && review.plan?.kind === 'launch-and-own-turnstile-form-review-v2') {
    state = 'manual_setup';
    reason = 'server_siteverify_and_delivery_approval_required';
  } else if (review?.status === 'blocked' && review.state === 'blocked_permission_or_plan') {
    state = 'blocked_permission_or_plan';
    reason = 'verified_form_requirements_missing';
  }
  return Object.freeze({feature:'contact_forms', state, reason, ...REVIEW_ONLY});
}
