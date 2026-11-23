// #89: read operator-approved forms cost/privacy rows for the toolkit consumer gate.
// No public route inserts into this table. Domain/operator grants are out of band.
import { hasCurrentOwnerSession } from './launch-jobs.mjs';
import { verifyStoredFormsCostPrivacyApproval } from '../pipeline/forms-cost-privacy-approval.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const stamp = () => Math.floor(Date.now() / 1000);

export async function formsCostPrivacySchemaReady(db) {
  try {
    await db.prepare(
      'SELECT id, forms_digest, status FROM onboarding_forms_cost_privacy_approvals LIMIT 0'
    ).all();
    return true;
  } catch { return false; }
}

const CURRENT_GATE = String.raw`
  SELECT g.* FROM onboarding_forms_cost_privacy_approvals g
  JOIN onboarding_option_approvals o ON o.id = g.forms_option_approval_id
  JOIN onboarding_launch_jobs j ON j.id = g.job_id
  WHERE g.job_id = ? AND g.github_user_id = ? AND g.cloudflare_account_id = ?
    AND g.pages_project_id = ? AND g.forms_digest = ? AND g.status = 'approved'
    AND g.expires_at > ? AND o.status = 'stored' AND o.kind = 'forms'
    AND o.job_id = g.job_id AND o.github_user_id = g.github_user_id
    AND o.cloudflare_account_id = g.cloudflare_account_id
    AND o.approval_digest = g.forms_digest
    AND j.status = 'live' AND j.expires_at > ?
    AND j.github_user_id = g.github_user_id
    AND j.cloudflare_account_id = g.cloudflare_account_id
    AND j.pages_project_id = g.pages_project_id
  LIMIT 1
`;

/**
 * Returns the consumer's verifyFormsCostPrivacyGate callback for the current owner.
 * Fail closed when schema/session/row/digest drift.
 */
export function createFormsCostPrivacyGate(env, current) {
  if (!env?.DB || !current) {
    return async () => {
      throw Object.assign(new Error('cost_privacy_gate_required'),
        {code: 'cost_privacy_gate_required'});
    };
  }

  return async function verifyFormsCostPrivacyGate({jobId, owner, site, formsDigest}) {
    if (!await formsCostPrivacySchemaReady(env.DB))
      throw Object.assign(new Error('cost_privacy_schema_required'),
        {code: 'cost_privacy_schema_required'});
    if (!current || owner?.githubUserId !== current.github_user_id ||
        owner?.cloudflareAccountId !== current.cloudflare_account_id ||
        !ACCOUNT.test(current.cloudflare_account_id || '') ||
        !await hasCurrentOwnerSession(env, current, stamp()))
      throw Object.assign(new Error('cost_privacy_session_required'),
        {code: 'cost_privacy_session_required'});
    if (!UUID.test(jobId || '') || !DIGEST.test(formsDigest || '') ||
        !site?.pagesProjectId || site.jobId !== jobId)
      throw Object.assign(new Error('cost_privacy_identity_required'),
        {code: 'cost_privacy_identity_required'});

    const row = await env.DB.prepare(CURRENT_GATE).bind(
      jobId, current.github_user_id, current.cloudflare_account_id,
      site.pagesProjectId, formsDigest.toLowerCase(), stamp(), stamp()
    ).first();
    if (!row)
      throw Object.assign(new Error('cost_privacy_gate_required'),
        {code: 'cost_privacy_gate_required'});

    return verifyStoredFormsCostPrivacyApproval(row, {
      jobId,
      githubUserId: owner.githubUserId,
      cloudflareAccountId: owner.cloudflareAccountId,
      pagesProjectId: site.pagesProjectId,
      formsDigest
    });
  };
}
