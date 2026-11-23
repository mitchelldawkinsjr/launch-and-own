// Issue #88: review-only Turnstile contact-form contract.
// Client widgets alone are never a working form. No Worker routes, secrets,
// DNS, or provider writes happen here.
import { createHash } from 'node:crypto';
import { TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const OPAQUE = /^[a-zA-Z0-9_-]{1,128}$/;
const REPO = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i;
const DELIVERY = new Set(['owner-email-forward', 'customer-owned-d1', 'customer-owned-webhook']);
const MAX_PLAN_TTL_SECONDS = 24 * 60 * 60;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

export const TURNSTILE_FREE_LIMITS = Object.freeze({
  widgetsPerAccount: 20,
  hostnamesPerWidget: 10,
  challenges: 'unlimited',
  tokenTtlSeconds: 300,
  siteverifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  docs: Object.freeze([
    'https://developers.cloudflare.com/turnstile/plans/',
    'https://developers.cloudflare.com/turnstile/get-started/server-side-validation/',
    'https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/'
  ])
});

const NEVER_ACTIVATE = Object.freeze({
  createResources: false,
  canActivate: false,
  canWrite: false,
  workingForm: false,
  widgetAloneInsufficient: true
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

function normalizeHostname(raw) {
  if (typeof raw !== 'string' || raw.length < 3 || raw.length > 253) return null;
  const host = raw.trim().toLowerCase();
  if (host.includes('://') || host.includes('/') || host.includes(':') || host.includes('*'))
    return null;
  if (!HOST.test(host) || !host.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))
    return null;
  if (/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return null;
  return host;
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
 * Review-only contact-form + Turnstile plan. Never mints secrets or claims a live form.
 *
 * Required caller-held inputs: trusted owner/site identity, explicit consent,
 * authorized hostname, delivery target, retention/deletion, and rate limit.
 * Server-side Siteverify is mandatory; a client widget alone is insufficient.
 */
export function buildTurnstileFormReviewPlan({
  owner, consent, hostname, deliveryTarget, retentionDays, deletionPlan,
  expectedAction, rateLimitPerHour
} = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  const trusted = snapshotOwner(owner);
  if (!trusted)
    return deny('not_available', 'verified_owner_site_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS
    });

  if (consent !== true)
    return deny('available_opt_in', 'owner_form_consent_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId
    });

  const host = normalizeHostname(hostname);
  if (!host)
    return deny('blocked_permission_or_plan', 'authorized_hostname_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId
    });

  if (!DELIVERY.has(deliveryTarget))
    return deny('blocked_permission_or_plan', 'customer_owned_delivery_target_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId
    });

  if (deliveryTarget === 'customer-owned-d1')
    return deny('blocked_permission_or_plan', 'form_storage_requires_separate_cost_and_privacy_review', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId,
      relatedIssue: '#89'
    });

  if (!positiveId(retentionDays) || retentionDays > 365
      || (deletionPlan !== 'owner-delete' && deletionPlan !== 'time-bound'))
    return deny('blocked_permission_or_plan', 'retention_and_deletion_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId
    });

  if (typeof expectedAction !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(expectedAction))
    return deny('blocked_permission_or_plan', 'exact_turnstile_action_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId
    });

  if (!positiveId(rateLimitPerHour) || rateLimitPerHour > 1000)
    return deny('blocked_permission_or_plan', 'rate_limit_required', {
      status: 'blocked',
      approvalDigest: null,
      freeLimits: TURNSTILE_FREE_LIMITS,
      siteId: trusted.siteId
    });

  const planBody = Object.freeze({
    kind: 'launch-and-own-turnstile-form-review-plan',
    version: 1,
    owner: trusted,
    hostname: host,
    deliveryTarget,
    retentionDays,
    deletionPlan,
    expectedAction,
    rateLimitPerHour,
    siteverify: Object.freeze({
      required: true,
      url: TURNSTILE_FREE_LIMITS.siteverifyUrl,
      tokenTtlSeconds: TURNSTILE_FREE_LIMITS.tokenTtlSeconds,
      singleUse: true,
      secretSource: 'customer_owned_turnstile_widget_secret',
      rejectOn: Object.freeze([
        'missing-input-secret',
        'missing-input-response',
        'invalid-input-response',
        'timeout-or-duplicate',
        'bad-request',
        'internal-error'
      ])
    }),
    abuseControls: Object.freeze({
      requireMatchingHostname: true,
      requireMatchingAction: true,
      maxHostnamesPerWidget: TURNSTILE_FREE_LIMITS.hostnamesPerWidget,
      maxWidgetsPerAccount: TURNSTILE_FREE_LIMITS.widgetsPerAccount
    }),
    ...NEVER_ACTIVATE,
    notices: Object.freeze([
      'A Turnstile client widget without server-side Siteverify is not a working contact form.',
      'Do not store Turnstile secrets in Git, chat, or customer HTML.',
      'Form delivery and any D1/Workers storage need separate owner approval and quota review.'
    ]),
    issuedAt: now,
    expiresAt: now + MAX_PLAN_TTL_SECONDS
  });

  return Object.freeze({
    status: 'review_only',
    state: 'available_opt_in',
    reason: 'awaiting_owner_digest_approval_and_server_siteverify',
    approvalDigest: createHash('sha256').update(stableJson(planBody), 'utf8').digest('hex'),
    plan: planBody,
    freeLimits: TURNSTILE_FREE_LIMITS,
    ...NEVER_ACTIVATE
  });
}

/** Toolkit contact_forms card projection. Never claims an enabled form. */
export function projectContactFormsCapability(review) {
  if (!review || typeof review !== 'object')
    return deny('not_available', 'form_review_required', { feature: 'contact_forms' });
  if (review.status === 'review_only')
    return Object.freeze({
      feature: 'contact_forms',
      state: 'available_opt_in',
      reason: 'server_siteverify_and_delivery_approval_required',
      ...NEVER_ACTIVATE
    });
  if (TOOLKIT_CAPABILITY_STATES.includes(review.state))
    return Object.freeze({
      feature: 'contact_forms',
      state: review.state,
      reason: review.reason,
      ...NEVER_ACTIVATE
    });
  return deny('not_available', 'unrecognized_form_review', { feature: 'contact_forms' });
}
