// Issue #89: digest-bound forms cost/privacy approval (review + stored-row gate).
// Never creates Turnstile, D1, Workers, or billing. A plan digest is not approval.
import { createHash, randomUUID } from 'node:crypto';
import { PUBLISHED_FREE_LIMITS } from './optional-service-budget.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PROJECT = /^[a-z0-9_-]{1,128}$/i;
const KIND = 'launch-and-own-forms-cost-privacy';
const SOURCE = 'stored-cost-privacy-approval';
const REVIEW_ONLY = Object.freeze({
  createResources: false,
  canActivate: false,
  canWrite: false,
  costEstimateUsd: null
});

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digestOf(plan) {
  return createHash('sha256').update(stableJson(plan), 'utf8').digest('hex');
}

function blocked(reason) {
  return Object.freeze({
    status: 'blocked',
    reason,
    approvalDigest: null,
    plan: null,
    gate: null,
    ...REVIEW_ONLY
  });
}

function positiveInt(n, min, max) {
  return Number.isSafeInteger(n) && n >= min && n <= max;
}

function identityOk({
  jobId, githubUserId, cloudflareAccountId, pagesProjectId, formsDigest
}) {
  return UUID.test(jobId || '') &&
    Number.isSafeInteger(githubUserId) && githubUserId > 0 &&
    typeof cloudflareAccountId === 'string' && ACCOUNT.test(cloudflareAccountId) &&
    typeof pagesProjectId === 'string' && PROJECT.test(pagesProjectId) &&
    typeof formsDigest === 'string' && DIGEST.test(formsDigest);
}

/**
 * Build a review-only forms cost/privacy plan bound to an exact #88 forms digest.
 * Does not store consent and never authorizes provider writes by itself.
 */
export function buildFormsCostPrivacyReview({
  jobId,
  githubUserId,
  cloudflareAccountId,
  pagesProjectId,
  formsDigest,
  retentionDays,
  maxSubmissionsPerDay,
  maxBodyBytes,
  costApproved,
  privacyApproved,
  budgetPlanDigest = null
} = {}) {
  if (!identityOk({jobId, githubUserId, cloudflareAccountId, pagesProjectId, formsDigest}))
    return blocked('verified_owner_and_forms_digest_required');
  if (costApproved !== true) return blocked('cost_owner_approval_required');
  if (privacyApproved !== true) return blocked('privacy_owner_approval_required');
  if (!positiveInt(retentionDays, 1, 365)) return blocked('retention_days_out_of_range');
  if (!positiveInt(maxSubmissionsPerDay, 1, 1000))
    return blocked('max_submissions_per_day_out_of_range');
  if (!positiveInt(maxBodyBytes, 256, 65536)) return blocked('max_body_bytes_out_of_range');
  if (budgetPlanDigest !== null &&
      (typeof budgetPlanDigest !== 'string' || !DIGEST.test(budgetPlanDigest)))
    return blocked('budget_plan_digest_invalid');

  const plan = Object.freeze({
    kind: KIND,
    version: 1,
    jobId,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    pagesProjectId,
    formsDigest: formsDigest.toLowerCase(),
    services: Object.freeze(['workers', 'd1']),
    purpose: 'contact-submissions',
    dataClassification: 'personal',
    deletionPlan: 'time-bound',
    customerResourceScope: 'customer-owned-dedicated',
    retentionDays,
    maxSubmissionsPerDay,
    maxBodyBytes,
    costApproved: true,
    privacyApproved: true,
    siteverifyRequired: true,
    publishedFreeLimits: Object.freeze({
      workers: PUBLISHED_FREE_LIMITS.workers,
      d1: PUBLISHED_FREE_LIMITS.d1
    }),
    budgetPlanDigest: budgetPlanDigest ? budgetPlanDigest.toLowerCase() : null,
    notices: Object.freeze([
      'This review does not create Turnstile, D1, Workers, or billing subscriptions.',
      'A stored #88 forms consent digest alone is not cost or privacy approval.',
      'prepareOptionalExtensionReview / budget digests alone never authorize forms.',
      'Server-side Turnstile Siteverify and a dedicated customer D1 are still required.',
      'Static Pages hosting stays usable without enabling this form path.'
    ]),
    ...REVIEW_ONLY
  });

  return Object.freeze({
    status: 'awaiting_cost_privacy_storage',
    plan,
    approvalDigest: digestOf(plan),
    ...REVIEW_ONLY
  });
}

function deny(reason) {
  const err = new Error(reason);
  err.code = reason;
  throw err;
}

/**
 * Recompute a stored approved #89 row into the gate shape required by
 * approved-extension-consumer. Fail closed on any drift.
 */
export function verifyStoredFormsCostPrivacyApproval(row, expected = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    deny('cost_privacy_row_required');
  if (row.status !== 'approved') deny('cost_privacy_not_approved');
  if (!UUID.test(row.id || '')) deny('cost_privacy_approval_id_invalid');
  if (!identityOk(expected)) deny('cost_privacy_expected_identity_invalid');

  let payload;
  try {
    payload = typeof row.payload_json === 'string'
      ? JSON.parse(row.payload_json)
      : row.payload;
  } catch {
    deny('cost_privacy_payload_invalid');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    deny('cost_privacy_payload_invalid');

  const rebuilt = buildFormsCostPrivacyReview({
    jobId: expected.jobId,
    githubUserId: expected.githubUserId,
    cloudflareAccountId: expected.cloudflareAccountId,
    pagesProjectId: expected.pagesProjectId,
    formsDigest: expected.formsDigest,
    retentionDays: payload.retentionDays,
    maxSubmissionsPerDay: payload.maxSubmissionsPerDay,
    maxBodyBytes: payload.maxBodyBytes,
    costApproved: payload.costApproved === true,
    privacyApproved: payload.privacyApproved === true,
    budgetPlanDigest: payload.budgetPlanDigest ?? null
  });
  if (rebuilt.status !== 'awaiting_cost_privacy_storage' || !rebuilt.plan)
    deny(rebuilt.reason || 'cost_privacy_rebuild_failed');

  const storedDigest = String(row.approval_digest || row.digest || '').toLowerCase();
  if (!DIGEST.test(storedDigest) || storedDigest !== rebuilt.approvalDigest)
    deny('cost_privacy_digest_mismatch');
  if (String(row.job_id || row.jobId || '') !== expected.jobId)
    deny('cost_privacy_job_mismatch');
  if (Number(row.github_user_id ?? row.githubUserId) !== expected.githubUserId)
    deny('cost_privacy_owner_mismatch');
  if (String(row.cloudflare_account_id || row.cloudflareAccountId || '').toLowerCase() !==
      expected.cloudflareAccountId.toLowerCase())
    deny('cost_privacy_account_mismatch');
  if (String(payload.formsDigest || '').toLowerCase() !== expected.formsDigest.toLowerCase())
    deny('cost_privacy_forms_digest_mismatch');
  if (String(payload.pagesProjectId || '') !== expected.pagesProjectId)
    deny('cost_privacy_project_mismatch');
  if (payload.plan && stableJson(payload.plan) !== stableJson(rebuilt.plan))
    deny('cost_privacy_plan_tampered');

  return Object.freeze({
    authorized: true,
    source: SOURCE,
    approvalId: row.id,
    jobId: expected.jobId,
    githubUserId: expected.githubUserId,
    cloudflareAccountId: expected.cloudflareAccountId.toLowerCase(),
    pagesProjectId: expected.pagesProjectId,
    formsDigest: expected.formsDigest.toLowerCase(),
    costApproved: true,
    privacyApproved: true,
    retentionDays: rebuilt.plan.retentionDays,
    maxSubmissionsPerDay: rebuilt.plan.maxSubmissionsPerDay,
    maxBodyBytes: rebuilt.plan.maxBodyBytes,
    createResources: false,
    canActivate: false,
    canWrite: false
  });
}

/** Test helper: materialize a would-be stored approved row from a review. */
export function materializeApprovedFormsCostPrivacyRow(review, {
  approvalId = randomUUID()
} = {}) {
  if (review?.status !== 'awaiting_cost_privacy_storage' || !review.plan)
    deny('cost_privacy_review_incomplete');
  return Object.freeze({
    id: approvalId,
    status: 'approved',
    job_id: review.plan.jobId,
    github_user_id: review.plan.githubUserId,
    cloudflare_account_id: review.plan.cloudflareAccountId,
    approval_digest: review.approvalDigest,
    payload_json: JSON.stringify({
      kind: KIND,
      formsDigest: review.plan.formsDigest,
      pagesProjectId: review.plan.pagesProjectId,
      retentionDays: review.plan.retentionDays,
      maxSubmissionsPerDay: review.plan.maxSubmissionsPerDay,
      maxBodyBytes: review.plan.maxBodyBytes,
      costApproved: true,
      privacyApproved: true,
      budgetPlanDigest: review.plan.budgetPlanDigest,
      plan: review.plan
    })
  });
}

export const FORMS_COST_PRIVACY_KIND = KIND;
export const FORMS_COST_PRIVACY_SOURCE = SOURCE;
