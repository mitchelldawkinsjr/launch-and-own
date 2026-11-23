// Issue #89 / GPT-6: pure, read-only owner-scoped optional-service planning.
// No provider requests, resource creation, consent recording, or billing actions.
// All account/usage/permission evidence MUST come from an authenticated backend.
const ACCOUNT = /^[a-f0-9]{32}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const OPAQUE = /^[a-z0-9_-]{1,128}$/i;
const PURPOSES = new Set(['contact-submissions', 'media-uploads', 'site-settings', 'lightweight-api']);
const CLASSIFICATIONS = new Set(['none', 'public', 'private', 'personal']);
const DELETE_PLANS = new Set(['none', 'owner-delete', 'time-bound']);
const MAX_EVIDENCE_AGE_SECONDS = 15 * 60;
const MAX_RETENTION_DAYS = 365;
const SERVICE_ORDER = ['workers', 'd1', 'kv', 'r2'];

function immutableLimits(metrics, url) {
  return Object.freeze({metrics: Object.freeze(metrics), documentation: url});
}
// Published Cloudflare Workers Free limits as checked on 2026-11-22.
// Units are explicit in metric keys: day, per invocation, GB, and billing month.
// These are ACCOUNT-WIDE allowances, NOT unspent balances or $0 guarantees.
export const PUBLISHED_FREE_LIMITS = Object.freeze({
  workers: immutableLimits({requestsPerDay:100000, cpuMsPerInvocation:10},
    'https://developers.cloudflare.com/workers/platform/pricing/'),
  d1: immutableLimits({rowsReadPerDay:5000000, rowsWrittenPerDay:100000,
    storedGb:5, databases:10}, 'https://developers.cloudflare.com/d1/platform/pricing/'),
  kv: immutableLimits({readsPerDay:100000, writesPerDay:1000,
    deletesPerDay:1000, listsPerDay:1000, storedGb:1, namespaces:1000},
    'https://developers.cloudflare.com/kv/platform/pricing/'),
  r2: immutableLimits({standardGbMonthsPerMonth:10, classAOpsPerMonth:1000000,
    classBOpsPerMonth:10000000},
    'https://developers.cloudflare.com/r2/pricing/')
});

function id(n) { return Number.isSafeInteger(n) && n > 0; }
function fits(re, x) { return typeof x === 'string' && re.test(x); }
function denied(reason) {
  return Object.freeze({state:'blocked_permission_or_plan', reason,
    services:Object.freeze([]), planDigest:null, canActivate:false, canWrite:false,
    costEstimateUsd:null, publishedFreeLimits:PUBLISHED_FREE_LIMITS});
}
function finiteNonnegative(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 &&
    x <= Number.MAX_SAFE_INTEGER;
}
function exactMetrics(obj, metrics) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(metrics);
  if (Object.keys(obj).length !== keys.length || Object.keys(obj).some(k=>!keys.includes(k))) return null;
  const clean = {};
  for (const key of keys) {
    if (!finiteNonnegative(obj[key])) return null;
    clean[key] = obj[key];
  }
  return Object.freeze(clean);
}
function safeIdentity(principal, site) {
  return id(principal?.githubUserId) && fits(ACCOUNT, principal?.cloudflareAccountId) &&
    id(site?.githubUserId) && site.githubUserId === principal.githubUserId &&
    site.cloudflareAccountId === principal.cloudflareAccountId &&
    id(site?.repositoryId) && fits(OPAQUE, site?.pagesProjectId) &&
    fits(SHA, site?.baseCommitSha) && site.productionBranch === 'main';
}
function safeAccountEvidence(principal, evidence, now) {
  return evidence?.kind === 'verified-account-plan-and-usage' &&
    evidence.githubUserId === principal.githubUserId &&
    evidence.cloudflareAccountId === principal.cloudflareAccountId &&
    ['free', 'paid'].includes(evidence.workersPlan) &&
    Number.isSafeInteger(evidence.checkedAt) && evidence.checkedAt <= now &&
    now - evidence.checkedAt <= MAX_EVIDENCE_AGE_SECONDS &&
    Number.isSafeInteger(evidence.expiresAt) && evidence.expiresAt > now &&
    evidence.expiresAt <= evidence.checkedAt + MAX_EVIDENCE_AGE_SECONDS &&
    evidence.usageByService && typeof evidence.usageByService === 'object' &&
    !Array.isArray(evidence.usageByService) &&
    evidence.permissions && typeof evidence.permissions === 'object' &&
    !Array.isArray(evidence.permissions);
}
function validateRequest(request) {
  if (!request || !Object.hasOwn(PUBLISHED_FREE_LIMITS, request.service) ||
      !PURPOSES.has(request.purpose) || !CLASSIFICATIONS.has(request.dataClassification) ||
      !DELETE_PLANS.has(request.deletionPlan) ||
      request.customerResourceScope !== 'customer-owned-dedicated' ||
      !Number.isSafeInteger(request.retentionDays) || request.retentionDays < 0 ||
      request.retentionDays > MAX_RETENTION_DAYS) return null;
  if ((request.dataClassification === 'none') !== (request.retentionDays === 0) ||
      (request.retentionDays === 0) !== (request.deletionPlan === 'none') ||
      (request.dataClassification === 'personal' && request.deletionPlan !== 'time-bound')) return null;
  if (request.service === 'r2' && request.storageClass !== 'standard') return null;
  if (request.service !== 'r2' && request.storageClass !== undefined) return null;
  const usage = exactMetrics(request.projectedUsage, PUBLISHED_FREE_LIMITS[request.service].metrics);
  if (!usage) return null;
  return Object.freeze({service:request.service, purpose:request.purpose,
    dataClassification:request.dataClassification, deletionPlan:request.deletionPlan,
    retentionDays:request.retentionDays, customerResourceScope:request.customerResourceScope,
    ...(request.service === 'r2' ? {storageClass:'standard'} : {}),
    projectedUsage:usage});
}
function projection(request, snapshot) {
  const service = request.service;
  const limit = PUBLISHED_FREE_LIMITS[service].metrics;
  const observed = exactMetrics(snapshot.usageByService[service], limit);
  const permission = snapshot.permissions[service] === true;
  const projected = {};
  const headroom = {};
  let exceeds = false;
  if (observed) {
    for (const [key, cap] of Object.entries(limit)) {
      // Account-wide usage + forecast is NOT an entitlement, only a provisional
      // estimate. CPU time is per invocation, not an additive daily meter.
      const value = key === 'cpuMsPerInvocation' ?
        Math.max(observed[key], request.projectedUsage[key]) :
        observed[key] + request.projectedUsage[key];
      if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
        return Object.freeze({service, state:'usage_unverified', reason:'invalid_projection',
          headroom:null, costEstimateUsd:null, readyForActivation:false});
      }
      projected[key] = value;
      headroom[key] = Math.max(0, cap-value);
      if (value > cap) exceeds = true;
    }
  }
  let state, reason;
  if (!permission) {
    state='blocked_permission_or_plan'; reason='service_scope_not_verified';
  } else if (service === 'r2' && snapshot.r2SubscriptionActive !== true) {
    state='subscription_activation_required'; reason='r2_requires_separate_subscription_checkout';
  } else if (snapshot.workersPlan === 'paid') {
    state='paid_cost_review_required'; reason='account_wide_paid_usage_and_billing_review_required';
  } else if (!observed) {
    state='usage_unverified'; reason='account_wide_usage_not_measured';
  } else if (exceeds) {
    state='projected_free_allowance_exceeded'; reason='account_wide_projected_usage_above_free_limit';
  } else {
    state='estimated_within_published_free_allowance';
    reason='forecast_only_not_a_zero_cost_guarantee';
  }
  // R2 can charge beyond its Standard free inclusion even on Workers Free.
  if (service === 'r2' && state === 'estimated_within_published_free_allowance') {
    state='billing_review_required'; reason='r2_subscription_and_usage_based_charges_possible';
  }
  return Object.freeze({service, state, reason,
    measuredAccountUsage:permission ? observed : null,
    projectedAccountUsage:permission && observed ? Object.freeze(projected) : null,
    estimatedFreeHeadroom:permission && observed && snapshot.workersPlan === 'free'
      ? Object.freeze(headroom) : null,
    publishedLimitDocumentation:PUBLISHED_FREE_LIMITS[service].documentation,
    costEstimateUsd:null, readyForActivation:false});
}
async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}

/**
 * Safely projects optional extension costs without enabling any of them.
 *
 * principal, site and accountEvidence must be collected server-side from current
 * authenticated provider/account evidence. This is NOT an authorization verifier.
 * The live caller must separately fence session epoch and grant revocation before
 * and after it fetches the evidence; no hosted caller exists in this slice.
 */
export async function prepareOptionalExtensionReview({
  principal, site, accountEvidence, requests
} = {}, {now = Math.floor(Date.now()/1000)} = {}) {
  if (!Number.isSafeInteger(now) || now < 1 || !safeIdentity(principal, site))
    return denied('trusted_site_identity_required');
  if (!safeAccountEvidence(principal, accountEvidence, now))
    return denied('fresh_verified_account_plan_and_usage_required');
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > SERVICE_ORDER.length)
    return denied('select_between_one_and_four_optional_services');
  const seen = new Set();
  const selected = [];
  for (const item of requests) {
    const valid = validateRequest(item);
    if (!valid || seen.has(valid.service)) return denied('invalid_or_duplicate_service_plan');
    seen.add(valid.service); selected.push(valid);
  }
  selected.sort((a,b)=>SERVICE_ORDER.indexOf(a.service)-SERVICE_ORDER.indexOf(b.service));

  // Deep copy the exact finite usage snapshot before the asynchronous digest.
  const snapshot = Object.freeze({
    kind:accountEvidence.kind, githubUserId:accountEvidence.githubUserId,
    cloudflareAccountId:accountEvidence.cloudflareAccountId,
    workersPlan:accountEvidence.workersPlan,
    r2SubscriptionActive:accountEvidence.r2SubscriptionActive === true,
    checkedAt:accountEvidence.checkedAt, expiresAt:accountEvidence.expiresAt,
    permissions:Object.freeze(Object.fromEntries(SERVICE_ORDER.map(k=>[k,accountEvidence.permissions[k] === true]))),
    usageByService:Object.freeze(Object.fromEntries(SERVICE_ORDER.map(k=>[
      k, exactMetrics(accountEvidence.usageByService[k],PUBLISHED_FREE_LIMITS[k].metrics)
    ])))
  });
  const identity = Object.freeze({githubUserId:site.githubUserId,
    repositoryId:site.repositoryId,cloudflareAccountId:site.cloudflareAccountId,
    pagesProjectId:site.pagesProjectId,baseCommitSha:site.baseCommitSha});
  const services = Object.freeze(selected.map(item=>projection(item,snapshot)));
  const manifest = Object.freeze({
    kind:'launch-and-own-optional-service-review-v1', identity, checkedAt:snapshot.checkedAt,
    workersPlan:snapshot.workersPlan, r2SubscriptionActive:snapshot.r2SubscriptionActive,
    selected, services
  });
  const digest = await sha256(JSON.stringify(manifest));
  // Reject in-flight mutation of any trust-bearing input. A digest alone is
  // never consent; future write adapters must re-read provider evidence again.
  if (!safeIdentity(principal,site) || !safeAccountEvidence(principal,accountEvidence,now) ||
      identity.repositoryId !== site.repositoryId ||
      identity.pagesProjectId !== site.pagesProjectId ||
      identity.baseCommitSha !== site.baseCommitSha ||
      identity.cloudflareAccountId !== site.cloudflareAccountId ||
      identity.githubUserId !== site.githubUserId ||
      snapshot.workersPlan !== accountEvidence.workersPlan ||
      snapshot.checkedAt !== accountEvidence.checkedAt ||
      snapshot.expiresAt !== accountEvidence.expiresAt ||
      snapshot.r2SubscriptionActive !== (accountEvidence.r2SubscriptionActive === true) ||
      SERVICE_ORDER.some(k=>snapshot.permissions[k] !== (accountEvidence.permissions[k] === true) ||
        JSON.stringify(snapshot.usageByService[k]) !== JSON.stringify(
          exactMetrics(accountEvidence.usageByService[k],PUBLISHED_FREE_LIMITS[k].metrics))) ||
      requests.length !== selected.length ||
      selected.some(item=>JSON.stringify(validateRequest(
        requests.find(x=>x?.service===item.service))) !== JSON.stringify(item)))
    return denied('account_or_forecast_changed_during_review');
  return Object.freeze({
    state:'review_only_not_activatable', services, planDigest:digest,
    accountEvidenceCheckedAt:snapshot.checkedAt,
    warnings:Object.freeze(['Quota headroom is shared across the owner account and is not a $0 guarantee.',
      'A digest is not customer approval; a new provider-backed authorization, cost and retention review is required before any write.',
      'R2 requires a separate customer-owned subscription even when its published Standard free inclusion applies.',
      'Existing private Launch & Own ZIP staging is NOT a customer R2 bucket.']),
    canActivate:false, canWrite:false, costEstimateUsd:null, publishedFreeLimits:PUBLISHED_FREE_LIMITS
  });
}
