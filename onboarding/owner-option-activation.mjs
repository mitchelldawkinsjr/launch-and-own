// Mint a short-lived execution grant from the owner's stored option approval.
// Same snapshot binding as operator grants; operator_grant_id is owner-self:<approvalId>.
import { readOwnedStoredOptionApproval } from './stored-option-approvals.mjs';
import { hasCurrentOwnerSession } from './launch-jobs.mjs';
import { isOptionExecutionConfigured } from './option-execution-store.mjs';
import { buildFormsCostPrivacyReview } from '../pipeline/forms-cost-privacy-approval.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const OWNER_KINDS = new Set(['domain', 'email', 'forms', 'analytics']);
const GATE_TTL = 60 * 60;
/** Defaults shown on the owner's forms turn-on page; the owner can change them within the #89 bounds. */
export const OWNER_FORMS_DEFAULTS = Object.freeze({ retentionDays: 30, maxSubmissionsPerDay: 50, maxBodyBytes: 8192 });
const EXECUTION_TTL = 15 * 60;

export function ownerSelfActivationEnabled(env, kind) {
  if (env?.OPTION_OWNER_ACTIVATION_ENABLED !== 'true' || !isOptionExecutionConfigured(env))
    return false;
  if (kind === 'domain') return env.OPTION_DOMAIN_ENABLED === 'true';
  if (kind === 'email') return env.OPTION_EMAIL_ENABLED === 'true';
  if (kind === 'forms') return env.OPTION_FORMS_ENABLED === 'true';
  if (kind === 'analytics') return env.OPTION_ANALYTICS_ENABLED === 'true';
  return false;
}

export async function mintOwnerExecutionGrant(env, current, approvalId, time = Math.floor(Date.now() / 1000)) {
  if (!UUID.test(approvalId || '') || !current)
    return null;
  const reviewed = await readOwnedStoredOptionApproval(env, current, approvalId, {time});
  if (!reviewed || !OWNER_KINDS.has(reviewed.kind) ||
      !ownerSelfActivationEnabled(env, reviewed.kind))
    return null;
  if (!await hasCurrentOwnerSession(env, current, time))
    return null;

  const payloadJson = JSON.stringify(reviewed.normalizedPayload);
  const site = reviewed.currentSite;
  const operatorGrantId = 'owner-self:' + reviewed.id;

  const existing = await env.DB.prepare(
    "SELECT id, status FROM onboarding_option_executions WHERE option_approval_id = ? LIMIT 1"
  ).bind(reviewed.id).first();
  if (existing?.status === 'approved') return existing.id;
  if (existing) return null;

  const executionId = crypto.randomUUID();
  const insert = await env.DB.prepare(
    `INSERT INTO onboarding_option_executions (
      id, option_approval_id, job_id, github_user_id, cloudflare_account_id, kind,
      approval_digest, payload_json, repository_id, pages_project_id, expected_commit_sha,
      authorization_epoch, operator_grant_id, approved_at, expires_at, status, updated_at
    )
    SELECT ?, o.id, j.id, j.github_user_id, j.cloudflare_account_id, o.kind,
      o.approval_digest, ?, j.repository_id, j.pages_project_id, j.expected_commit_sha,
      ?, ?, ?, ?, 'approved', ?
    FROM onboarding_option_approvals o
    JOIN onboarding_launch_jobs j ON j.id = o.job_id
    JOIN onboarding_sessions s ON s.id_hash = ? AND s.authorization_epoch = ?
      AND s.github_user_id = j.github_user_id AND s.cloudflare_account_id = j.cloudflare_account_id
      AND s.expires_at > ? AND s.github_token_ct IS NOT NULL AND s.cloudflare_token_ct IS NOT NULL
    WHERE o.id = ? AND o.status = 'stored' AND o.kind IN ('domain', 'email', 'forms', 'analytics')
      AND j.id = o.job_id AND j.status = 'live' AND j.expires_at > ?
      AND j.github_user_id = ? AND j.cloudflare_account_id = ?`
  ).bind(
    executionId, payloadJson, current.authorization_epoch, operatorGrantId,
    time, time + EXECUTION_TTL, time,
    current.hash, current.authorization_epoch, time,
    reviewed.id, time, current.github_user_id, current.cloudflare_account_id
  ).run();
  return insert.meta.changes === 1 ? executionId : null;
}
/**
 * Owner decision 2026-11-26: the site owner's own explicit cost and privacy acknowledgement replaces the
 * out-of-band operator row for the #89 forms gate. The same review builder and the same execution-time
 * verifier apply; an operator-approved row is never overwritten. Returns {ok:true} or {ok:false, reason}.
 */
export async function storeOwnerFormsCostPrivacy(env, current, approvalId, choices, time = Math.floor(Date.now() / 1000)) {
  if (!UUID.test(approvalId || '') || !current) return { ok: false, reason: 'forms_request_required' };
  const reviewed = await readOwnedStoredOptionApproval(env, current, approvalId, { time });
  if (!reviewed || reviewed.kind !== 'forms' || !ownerSelfActivationEnabled(env, 'forms'))
    return { ok: false, reason: 'forms_request_required' };
  const site = reviewed.currentSite;
  const review = buildFormsCostPrivacyReview({
    jobId: site.jobId, githubUserId: site.githubUserId, cloudflareAccountId: site.cloudflareAccountId,
    pagesProjectId: site.pagesProjectId, formsDigest: reviewed.digest,
    retentionDays: choices?.retentionDays, maxSubmissionsPerDay: choices?.maxSubmissionsPerDay, maxBodyBytes: choices?.maxBodyBytes,
    costApproved: choices?.costApproved === true, privacyApproved: choices?.privacyApproved === true
  });
  if (review.status !== 'awaiting_cost_privacy_storage') return { ok: false, reason: review.reason };
  if (!await hasCurrentOwnerSession(env, current, time)) return { ok: false, reason: 'cost_privacy_session_required' };
  const plan = review.plan;
  const grantId = 'owner-self-cost-privacy:' + reviewed.id;
  const write = await env.DB.prepare(
    `INSERT INTO onboarding_forms_cost_privacy_approvals (
      id, forms_option_approval_id, job_id, github_user_id, cloudflare_account_id, pages_project_id,
      forms_digest, approval_digest, payload_json, retention_days, max_submissions_per_day, max_body_bytes,
      operator_grant_id, approved_at, expires_at, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)
    ON CONFLICT(forms_option_approval_id) DO UPDATE SET
      approval_digest = excluded.approval_digest, payload_json = excluded.payload_json,
      retention_days = excluded.retention_days, max_submissions_per_day = excluded.max_submissions_per_day,
      max_body_bytes = excluded.max_body_bytes, approved_at = excluded.approved_at, expires_at = excluded.expires_at,
      status = 'approved', updated_at = excluded.updated_at
    WHERE onboarding_forms_cost_privacy_approvals.operator_grant_id = excluded.operator_grant_id
      AND onboarding_forms_cost_privacy_approvals.github_user_id = excluded.github_user_id`
  ).bind(
    crypto.randomUUID(), reviewed.id, site.jobId, site.githubUserId, site.cloudflareAccountId, site.pagesProjectId,
    reviewed.digest, review.approvalDigest, JSON.stringify(plan), plan.retentionDays, plan.maxSubmissionsPerDay, plan.maxBodyBytes,
    grantId, time, time + GATE_TTL, time
  ).run();
  return write.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'cost_privacy_row_conflict' };
}
