// Issue #89: read-only Workers/D1/KV/R2 extension cost guardrails.
// No resource creation, billing activation, OAuth changes, or provider writes.
import { createHash } from 'node:crypto';
import { TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const OPAQUE = /^[a-zA-Z0-9_-]{1,128}$/;
const REPO = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const EXTENSIONS = Object.freeze(['pages_functions', 'd1', 'kv', 'r2']);
const PLANS = Object.freeze(['workers_free', 'workers_paid', 'unknown']);
const MAX_PLAN_TTL_SECONDS = 24 * 60 * 60;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

// Published Free allowances reviewed 2026-11-22 against Cloudflare docs.
// Declared plan limits do not prove remaining quota for a specific account.
export const FREE_ALLOWANCES = Object.freeze({
  pages_functions: Object.freeze({
    requestsPerDay: 100_000,
    cpuMsPerInvocation: 10,
    docs: Object.freeze([
      'https://developers.cloudflare.com/workers/platform/limits/',
      'https://developers.cloudflare.com/workers/platform/pricing/'
    ]),
    notes: Object.freeze([
      'Static Pages asset requests remain free and unlimited.',
      'Measured ZIP upload used 95 ms Worker CPU against the Free 10 ms per-invocation limit (#45).'
    ])
  }),
  d1: Object.freeze({
    rowsReadPerDay: 5_000_000,
    rowsWrittenPerDay: 100_000,
    storageGb: 5,
    databases: 10,
    docs: Object.freeze(['https://developers.cloudflare.com/d1/platform/pricing/']),
    notes: Object.freeze([
      'Launch & Own onboarding D1 is platform-owned and separate from customer form/PII storage.'
    ])
  }),
  kv: Object.freeze({
    readsPerDay: 100_000,
    writesPerDay: 1_000,
    deletesPerDay: 1_000,
    listsPerDay: 1_000,
    storageGb: 1,
    docs: Object.freeze(['https://developers.cloudflare.com/kv/platform/pricing/']),
    notes: Object.freeze(['Dashboard and CLI operations count toward the same Free quotas.'])
  }),
  r2: Object.freeze({
    storageGbMonth: 10,
    classAOpsPerMonth: 1_000_000,
    classBOpsPerMonth: 10_000_000,
    egress: 'free',
    requiresExplicitActivation: true,
    docs: Object.freeze([
      'https://developers.cloudflare.com/r2/pricing/#free-tier',
      'https://developers.cloudflare.com/r2/get-started/'
    ]),
    notes: Object.freeze([
      'R2 Standard free tier requires explicit subscription activation in the owner account.',
      'Platform ZIP staging R2 is not a customer optional media bucket.'
    ])
  })
});

// Never-activate invariants shared with GPT-6 #104: this module cannot enable
// billing, invent a dollar cost, or authorize provider writes.
const NEVER_ACTIVATE = Object.freeze({
  createResources: false,
  canActivate: false,
  canWrite: false,
  costEstimateUsd: null
});

function deny(state, reason, extras = {}) {
  if (!TOOLKIT_CAPABILITY_STATES.includes(state)) throw Error('unknown capability state');
  return Object.freeze({ state, reason, ...NEVER_ACTIVATE, ...extras });
}

function snapshotOwner(owner) {
  if (!owner || !positiveId(owner.githubUserId) || !positiveId(owner.repositoryId)
      || typeof owner.githubLogin !== 'string' || !LOGIN.test(owner.githubLogin)
      || typeof owner.cloudflareAccountId !== 'string' || !ACCOUNT.test(owner.cloudflareAccountId)
      || typeof owner.siteId !== 'string' || !OPAQUE.test(owner.siteId)
      || typeof owner.pagesProjectId !== 'string' || !OPAQUE.test(owner.pagesProjectId)
      || typeof owner.repositoryName !== 'string' || !REPO.test(owner.repositoryName)
      || owner.branch !== 'main')
    return null;
  return Object.freeze({
    githubUserId: owner.githubUserId,
    githubLogin: owner.githubLogin,
    cloudflareAccountId: owner.cloudflareAccountId.toLowerCase(),
    siteId: owner.siteId,
    pagesProjectId: owner.pagesProjectId,
    repositoryId: owner.repositoryId,
    repositoryName: owner.repositoryName,
    branch: 'main'
  });
}

function normalizePlanEvidence(evidence, now) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (!PLANS.includes(evidence.workersPlan)) return null;
  if (!positiveId(evidence.checkedAt) || !positiveId(evidence.expiresAt)) return null;
  if (evidence.checkedAt > now || evidence.expiresAt <= now) return null;
  if (evidence.expiresAt - evidence.checkedAt > MAX_PLAN_TTL_SECONDS) return null;
  if (typeof evidence.cloudflareAccountId !== 'string' || !ACCOUNT.test(evidence.cloudflareAccountId))
    return null;
  const r2Activated = evidence.r2Activated === true ? true
    : evidence.r2Activated === false ? false : null;
  return Object.freeze({
    workersPlan: evidence.workersPlan,
    cloudflareAccountId: evidence.cloudflareAccountId.toLowerCase(),
    r2Activated,
    checkedAt: evidence.checkedAt,
    expiresAt: evidence.expiresAt,
    source: evidence.source === 'provider_read' || evidence.source === 'manual_dashboard'
      ? evidence.source : 'unverified'
  });
}

function usageDashboardUrl(accountId) {
  return `https://dash.cloudflare.com/${accountId}/workers/overview`;
}

function r2ActivationUrl(accountId) {
  return `https://dash.cloudflare.com/${accountId}/r2/overview`;
}

/** Catalog of optional advanced extensions. Static Pages hosting is never gated by these. */
export function listExtensionCatalog() {
  return Object.freeze(EXTENSIONS.map(id => Object.freeze({
    id,
    defaultState: id === 'r2' ? 'blocked_permission_or_plan' : 'available_opt_in',
    freeAllowance: FREE_ALLOWANCES[id],
    platformOwnedDistinctResource: id === 'r2'
      ? 'platform_zip_staging_r2_is_not_customer_bucket'
      : id === 'd1'
        ? 'platform_onboarding_d1_is_not_customer_form_storage'
        : null
  })));
}

/**
 * Project eligibility for optional extensions from server-held owner identity and
 * short-lived plan evidence. Never creates resources or activates billing.
 */
export function assessExtensionEligibility({ owner, planEvidence, consent } = {},
  { now = Math.floor(Date.now() / 1000) } = {}) {
  const trusted = snapshotOwner(owner);
  if (!trusted) return deny('not_available', 'verified_owner_site_required', {
    extensions: Object.freeze({}),
    usageDashboardUrl: null
  });

  const plan = normalizePlanEvidence(planEvidence, now);
  if (!plan || plan.cloudflareAccountId !== trusted.cloudflareAccountId)
    return deny('manual_setup', 'fresh_plan_evidence_required', {
      extensions: Object.freeze(Object.fromEntries(EXTENSIONS.map(id => [id, deny(
        'manual_setup', 'review_workers_usage_dashboard'
      )]))),
      usageDashboardUrl: usageDashboardUrl(trusted.cloudflareAccountId),
      r2ActivationUrl: r2ActivationUrl(trusted.cloudflareAccountId),
      staticSiteRemainsAvailable: true
    });

  if (consent !== true)
    return deny('available_opt_in', 'owner_extension_consent_required', {
      extensions: Object.freeze(Object.fromEntries(EXTENSIONS.map(id => [id, deny(
        'available_opt_in', 'explicit_owner_opt_in_required'
      )]))),
      usageDashboardUrl: usageDashboardUrl(trusted.cloudflareAccountId),
      r2ActivationUrl: r2ActivationUrl(trusted.cloudflareAccountId),
      workersPlan: plan.workersPlan,
      staticSiteRemainsAvailable: true
    });

  const extensions = {};
  for (const id of EXTENSIONS) {
    if (plan.workersPlan === 'unknown') {
      extensions[id] = deny('manual_setup', 'workers_plan_unverified');
      continue;
    }
    if (id === 'r2') {
      if (plan.r2Activated !== true) {
        extensions[id] = deny('blocked_permission_or_plan', 'r2_subscription_activation_required', {
          activationUrl: r2ActivationUrl(trusted.cloudflareAccountId)
        });
        continue;
      }
      extensions[id] = deny('available_opt_in', 'r2_activated_awaiting_exact_resource_approval');
      continue;
    }
    if (plan.workersPlan === 'workers_free' && id === 'pages_functions') {
      extensions[id] = deny('available_opt_in', 'workers_free_cpu_and_request_limits_apply', {
        freeAllowance: FREE_ALLOWANCES.pages_functions
      });
      continue;
    }
    extensions[id] = deny('available_opt_in', 'exact_resource_plan_approval_required', {
      freeAllowance: FREE_ALLOWANCES[id]
    });
  }

  return Object.freeze({
    state: 'available_opt_in',
    reason: 'review_exact_extension_plan',
    ...NEVER_ACTIVATE,
    owner: trusted,
    workersPlan: plan.workersPlan,
    planCheckedAt: plan.checkedAt,
    planExpiresAt: plan.expiresAt,
    extensions: Object.freeze(extensions),
    usageDashboardUrl: usageDashboardUrl(trusted.cloudflareAccountId),
    r2ActivationUrl: r2ActivationUrl(trusted.cloudflareAccountId),
    staticSiteRemainsAvailable: true,
    platformZipR2Distinct: true,
    // Account-wide usage/forecast math lives in GPT-6 optional-service-budget (#104).
    usageForecastReview: 'separate_optional_service_budget_module'
  });
}

/**
 * Map eligibility into the toolkit `advanced_services` capability card for #87.
 * Does not claim remaining Free quota or authorize activation.
 */
export function projectAdvancedServicesCapability(eligibility) {
  if (!eligibility || typeof eligibility !== 'object')
    return deny('not_available', 'eligibility_required');
  const base = {
    feature: 'advanced_services',
    usageForecastReview: eligibility.usageForecastReview || 'separate_optional_service_budget_module',
    staticSiteRemainsAvailable: eligibility.staticSiteRemainsAvailable !== false,
    ...NEVER_ACTIVATE
  };
  if (eligibility.state === 'not_available')
    return Object.freeze({ ...base, state: 'not_available', reason: eligibility.reason });
  if (eligibility.state === 'manual_setup')
    return Object.freeze({
      ...base,
      state: 'manual_setup',
      reason: eligibility.reason,
      actionLabel: 'Review Workers usage',
      actionUrl: eligibility.usageDashboardUrl || null
    });
  if (eligibility.extensions?.r2?.state === 'blocked_permission_or_plan')
    return Object.freeze({
      ...base,
      state: 'blocked_permission_or_plan',
      reason: 'r2_or_plan_gates_remain',
      actionLabel: 'Review R2 activation',
      actionUrl: eligibility.r2ActivationUrl || null
    });
  if (eligibility.state === 'available_opt_in')
    return Object.freeze({
      ...base,
      state: 'available_opt_in',
      reason: eligibility.reason === 'review_exact_extension_plan'
        ? 'exact_extension_plan_and_usage_forecast_required'
        : eligibility.reason,
      actionLabel: 'Review optional services',
      actionUrl: eligibility.usageDashboardUrl || null
    });
  return Object.freeze({ ...base, state: 'not_available', reason: 'unrecognized_eligibility' });
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Build a digest-bound, review-only extension approval plan. Does not call Cloudflare.
 * Callers must re-validate owner identity, plan evidence, and consent before any future write path.
 */
function blockedPlan(reason, extras = {}) {
  return Object.freeze({
    status: 'blocked',
    reason,
    approvalDigest: null,
    ...NEVER_ACTIVATE,
    staticSiteRemainsAvailable: true,
    ...extras
  });
}

export function buildExtensionReviewPlan({
  owner, planEvidence, consent, selectedExtensions, expectedMonthlyUsage, retentionDays
} = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (consent !== true) return blockedPlan('owner_extension_consent_required');

  const eligibility = assessExtensionEligibility({ owner, planEvidence, consent }, { now });
  // Only the consented, plan-verified path may mint a digest. available_opt_in
  // without review_exact_extension_plan still means "ask first," not "plan ready."
  if (eligibility.reason !== 'review_exact_extension_plan'
      || eligibility.createResources !== false
      || eligibility.canActivate !== false
      || eligibility.canWrite !== false)
    return blockedPlan(eligibility.reason);

  if (!Array.isArray(selectedExtensions) || selectedExtensions.length === 0
      || selectedExtensions.some(id => !EXTENSIONS.includes(id))
      || new Set(selectedExtensions).size !== selectedExtensions.length)
    return blockedPlan('exact_extension_selection_required');

  for (const id of selectedExtensions) {
    const item = eligibility.extensions[id];
    if (!item || item.state !== 'available_opt_in')
      return blockedPlan(item?.reason || 'extension_not_eligible', { extension: id });
  }

  if (!expectedMonthlyUsage || typeof expectedMonthlyUsage !== 'object'
      || typeof expectedMonthlyUsage.summary !== 'string'
      || expectedMonthlyUsage.summary.length < 8
      || expectedMonthlyUsage.summary.length > 500
      || expectedMonthlyUsage.summary !== expectedMonthlyUsage.summary.trim())
    return blockedPlan('expected_monthly_usage_summary_required');

  if (!positiveId(retentionDays) || retentionDays > 365)
    return blockedPlan('retention_days_required');

  const selected = [...selectedExtensions].sort();
  const planBody = Object.freeze({
    kind: 'launch-and-own-extension-review-plan',
    version: 1,
    owner: eligibility.owner,
    workersPlan: eligibility.workersPlan,
    selectedExtensions: Object.freeze(selected),
    expectedMonthlyUsage: Object.freeze({
      summary: expectedMonthlyUsage.summary.trim()
    }),
    retentionDays,
    deletion: 'owner_deletes_customer_owned_resources',
    rollback: 'disable_extension_keep_static_pages',
    ...NEVER_ACTIVATE,
    billingActivation: selected.includes('r2') ? 'owner_confirmed_r2_activated' : 'not_required',
    platformZipR2Distinct: true,
    usageForecastReview: 'separate_optional_service_budget_module',
    issuedAt: now,
    expiresAt: Math.min(eligibility.planExpiresAt, now + MAX_PLAN_TTL_SECONDS)
  });

  const approvalDigest = createHash('sha256').update(stableJson(planBody), 'utf8').digest('hex');
  return Object.freeze({
    status: 'review_only',
    reason: 'awaiting_owner_digest_approval',
    approvalDigest,
    plan: planBody,
    ...NEVER_ACTIVATE,
    usageDashboardUrl: eligibility.usageDashboardUrl,
    r2ActivationUrl: eligibility.r2ActivationUrl,
    staticSiteRemainsAvailable: true,
    notices: Object.freeze([
      'Static Pages hosting stays available if an extension hits Free-plan quotas or is paused.',
      'This plan does not create Workers, D1, KV, or R2 resources and does not activate billing.',
      'Platform ZIP staging R2 is a separate Launch & Own resource from any customer optional bucket.',
      'Account-wide usage and Free-overrun forecasts require the separate optional-service-budget review.'
    ])
  });
}

/**
 * Budget pause projection: extensions stop; the verified static site stays usable.
 * No provider mutation occurs here.
 */
export function projectBudgetPause({ owner, extension, providerDenial } = {}) {
  const trusted = snapshotOwner(owner);
  if (!trusted || !EXTENSIONS.includes(extension))
    return deny('not_available', 'verified_owner_and_extension_required', {
      staticSiteRemainsAvailable: true,
      extensionPaused: false
    });
  const reason = providerDenial === true ? 'provider_denied_or_quota_exhausted'
    : 'budget_guardrail_pause';
  return Object.freeze({
    state: 'blocked_permission_or_plan',
    reason,
    extension,
    extensionPaused: true,
    ...NEVER_ACTIVATE,
    staticSiteRemainsAvailable: true,
    siteId: trusted.siteId,
    cloudflareAccountId: trusted.cloudflareAccountId
  });
}

export const EXTENSION_IDS = EXTENSIONS;
