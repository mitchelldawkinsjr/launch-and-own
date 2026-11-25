// #88 / Agent 2: read actual 0005 option approval requests. Never authorizes provider writes.
import { hasCurrentOwnerSession, isLaunchId } from './launch-jobs.mjs';
import { validateStoredOptionApproval } from '../pipeline/stored-option-approval.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const OPAQUE = /^[a-z0-9_-]{1,128}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nowSec = () => Math.floor(Date.now() / 1000);

const READ_ROW = [
  'SELECT o.id, o.job_id, o.github_user_id, o.cloudflare_account_id,',
  'o.kind, o.approval_digest, o.payload_json, o.status,',
  'j.github_login, j.customer_name, j.site_slug,',
  'j.repository_id, j.pages_project_id, j.production_branch,',
  'j.expected_commit_sha, j.expires_at AS job_expires_at',
  'FROM onboarding_option_approvals o',
  'JOIN onboarding_launch_jobs j ON j.id = o.job_id',
  'WHERE o.id = ? AND o.github_user_id = ? AND o.cloudflare_account_id = ?',
  "AND o.status = 'stored'",
  'AND j.github_user_id = o.github_user_id',
  'AND j.cloudflare_account_id = o.cloudflare_account_id',
  "AND j.status = 'live' AND j.expires_at > ?",
  'LIMIT 1'
].join(' ');

/**
 * Read one Agent 1 option request only for a currently signed-in, verified
 * GitHub/Cloudflare owner and live launch. D1 identity is not a browser input.
 *
 * The 0005 schema enforces status='stored' and DOES NOT permit an atomic
 * provider execution claim. A distinct, operator-authorized CAS execution
 * record must be created later; returned canWrite/canActivate remain false.
 */
export async function readOwnedStoredOptionApproval(env, current, approvalId, {
  time = nowSec()
} = {}) {
  if (!UUID.test(approvalId || '') || !current ||
      !Number.isSafeInteger(time) || time <= 0 ||
      !Number.isSafeInteger(current.github_user_id) ||
      typeof current.github_login !== 'string' ||
      typeof current.cloudflare_account_id !== 'string')
    return null;
  if (!await hasCurrentOwnerSession(env, current, time)) return null;
  const item = await env.DB.prepare(READ_ROW)
    .bind(approvalId, current.github_user_id, current.cloudflare_account_id, time)
    .first();
  if (!item) return null;
  if (!isLaunchId(item.job_id) || !Number.isSafeInteger(item.repository_id) ||
      item.repository_id <= 0 || !OPAQUE.test(item.pages_project_id || '') ||
      !SLUG.test(item.site_slug || '') || item.production_branch !== 'main' ||
      !COMMIT.test(item.expected_commit_sha || '') ||
      item.github_login?.toLowerCase() !== current.github_login.toLowerCase())
    return null;
  const checked = validateStoredOptionApproval(item, {
    jobId: item.job_id, githubUserId: current.github_user_id,
    githubLogin: current.github_login,
    cloudflareAccountId: current.cloudflare_account_id,
    customerName: item.customer_name,
    pagesProjectName: 'esp-' + item.site_slug + '-site'
  });
  if (!await hasCurrentOwnerSession(env, current, Math.floor(Date.now() / 1000)))
    return null;
  return Object.freeze({
    ...checked,
    currentSite: Object.freeze({
      jobId: item.job_id,
      githubUserId: current.github_user_id,
      githubLogin: current.github_login,
      cloudflareAccountId: current.cloudflare_account_id,
      repositoryId: item.repository_id,
      repositoryName: 'esp-' + item.site_slug,
      pagesProjectId: item.pages_project_id,
      pagesProjectName: 'esp-' + item.site_slug + '-site',
      productionBranch: 'main',
      expectedCommitSha: item.expected_commit_sha.toLowerCase(),
      status: 'live'
    })
  });
}
