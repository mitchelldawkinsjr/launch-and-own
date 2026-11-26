// Mint a short-lived execution grant from the owner's stored option approval.
// Same snapshot binding as operator grants; operator_grant_id is owner-self:<approvalId>.
import { readOwnedStoredOptionApproval } from './stored-option-approvals.mjs';
import { hasCurrentOwnerSession } from './launch-jobs.mjs';
import { isOptionExecutionConfigured } from './option-execution-store.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const OWNER_KINDS = new Set(['domain', 'email']);
const EXECUTION_TTL = 15 * 60;

export function ownerSelfActivationEnabled(env, kind) {
  if (env?.OPTION_OWNER_ACTIVATION_ENABLED !== 'true' || !isOptionExecutionConfigured(env))
    return false;
  if (kind === 'domain') return env.OPTION_DOMAIN_ENABLED === 'true';
  if (kind === 'email') return env.OPTION_EMAIL_ENABLED === 'true';
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
      lower(o.approval_digest), ?, j.repository_id, j.pages_project_id, lower(j.expected_commit_sha),
      ?, ?, ?, ?, 'approved', ?
    FROM onboarding_option_approvals o
    JOIN onboarding_launch_jobs j ON j.id = o.job_id
    JOIN onboarding_sessions s ON s.id_hash = ? AND s.authorization_epoch = ?
      AND s.github_user_id = j.github_user_id AND s.cloudflare_account_id = j.cloudflare_account_id
      AND s.expires_at > ? AND s.github_token_ct IS NOT NULL AND s.cloudflare_token_ct IS NOT NULL
    WHERE o.id = ? AND o.status = 'stored' AND o.kind IN ('domain', 'email')
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