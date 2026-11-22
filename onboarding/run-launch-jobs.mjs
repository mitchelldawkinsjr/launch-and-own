import { verifyProviderConnections } from '../pipeline/authorization-checks.mjs';
import { verifyCloudflareAccount } from '../pipeline/cloudflare-oauth.mjs';
import { applyWebsite } from '../pipeline/provision-site.mjs';
import { ProviderRequestError } from '../pipeline/provider-errors.mjs';
import { verifyWebsite } from '../pipeline/verify-site.mjs';
import { activeJobSession, approvalSnapshot, HAS_APPROVAL, RUNNABLE, UNCLAIMED } from './launch-jobs.mjs';
import { AuthorizationRefreshBusy, getFreshAccessToken } from './token-lifecycle.mjs';

const clock = () => Math.floor(Date.now() / 1000);
const LEASE_SECONDS = 120;
const REQUEST_SECONDS = 8;
const MAX_ATTEMPTS = 5;
const SWEEP_LIMIT = 50;
const retryDelay = attempt => Math.min(240, 30 * 2 ** (attempt - 1));

class AuthorizationEnded extends Error {
  constructor(code = 'session_ended') {
    super(code);
    this.code = code;
  }
}
class ClaimLost extends Error {}
class JobStorageUnavailable extends Error {}

async function claimJob(env, id, sessionHash) {
  const time = clock();
  return await env.DB.prepare(`UPDATE onboarding_launch_jobs AS j SET lease_id = ?, lease_until = ?,
    attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND ${RUNNABLE} AND ${UNCLAIMED} AND next_attempt_at <= ?
      AND attempts < ? AND expires_at > ? AND ${HAS_APPROVAL}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM onboarding_launch_job_sessions a
        WHERE a.job_id = j.id AND a.session_hash = ?))
    RETURNING *`)
    .bind(crypto.randomUUID(), time + LEASE_SECONDS, time, id, time, time, MAX_ATTEMPTS,
      time + REQUEST_SECONDS, time + REQUEST_SECONDS, sessionHash, sessionHash).first();
}

async function writeActiveClaim(env, job, fields, values) {
  const time = clock();
  let result;
  try {
    result = await env.DB.prepare(`UPDATE onboarding_launch_jobs AS j SET ${fields}
      WHERE id = ? AND lease_id = ? AND lease_until > ? AND expires_at > ? AND ${RUNNABLE}
        AND ${HAS_APPROVAL} RETURNING id`)
      .bind(...values, job.id, job.lease_id, time, time, time).first();
  } catch {
    throw new JobStorageUnavailable();
  }
  if (!result) throw new ClaimLost();
}

async function pauseJob(env, job, code) {
  // Keep the lease fence until its deadline. A previously admitted provider
  // request could still be completing even after local approval disappeared.
  await env.DB.prepare(`UPDATE onboarding_launch_jobs AS j
    SET status = 'needs_reauthorization', error_code = ?, updated_at = ?
    WHERE id = ? AND lease_id = ? AND ${RUNNABLE}`)
    .bind(code, clock(), job.id, job.lease_id).run();
}

async function finishAttempt(env, job, code, { retryable = false, retryAfter = 0 } = {}) {
  const time = clock();
  const exhausted = retryable && job.attempts >= MAX_ATTEMPTS;
  const status = retryable && !exhausted ? job.status : 'failed';
  await writeActiveClaim(env, job, `status = ?, error_code = ?, updated_at = ?, next_attempt_at = ?,
    lease_id = NULL, lease_until = NULL`, [
    status, exhausted ? 'retry_budget_exhausted' : code, time,
    time + Math.max(retryDelay(job.attempts), Math.min(600, retryAfter))
  ]);
}

function guardedFetch(env, job, credentialsValid) {
  return async (url, options = {}) => {
    const deadline = clock() + REQUEST_SECONDS;
    if (job.lease_until <= deadline) throw new ProviderRequestError();
    const authorization = await readActiveSession(env, job, deadline, { credentialsValid });
    const requestDeadline = clock() + REQUEST_SECONDS;
    if (job.lease_until <= requestDeadline) throw new ProviderRequestError();
    if (!authorization || authorization.authorized_until <= requestDeadline) throw new AuthorizationEnded();
    const timeout = AbortSignal.timeout(REQUEST_SECONDS * 1000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      // Workers only allow follow/manual redirects; default manual and fail closed on non-2xx.
      return await fetch(url, { ...options, signal, redirect: options.redirect ?? 'manual' });
    } catch {
      throw new ProviderRequestError();
    }
  };
}

async function readActiveSession(env, job, deadline, options) {
  try {
    return await activeJobSession(env, job, deadline, options);
  } catch {
    throw new JobStorageUnavailable();
  }
}

async function requireProviderAccess(check) {
  try {
    await check();
  } catch (error) {
    if (error instanceof JobStorageUnavailable || error instanceof AuthorizationEnded ||
        (error instanceof ProviderRequestError && error.retryable)) throw error;
    let detail = 'provider_authorization_required';
    if (error instanceof ProviderRequestError) {
      detail = `provider_http_${error.status || 'unknown'}`;
    } else if (typeof error?.message === 'string' && error.message.trim()) {
      // Safe, stable operator code: no spaces/PII, still more specific than a generic pause.
      detail = ('provider_' + error.message.toLowerCase().replace(/[^a-z0-9]+/g, '_')).replace(/_+/g, '_').slice(0, 64).replace(/^_|_$/g, '');
      if (detail.length < 12) detail = 'provider_authorization_required';
    }
    throw new AuthorizationEnded(detail);
  }
}

async function verifiedConnections(env, job, input) {
  const session = await readActiveSession(env, job, clock() + REQUEST_SECONDS, { loadGrants: true });
  if (!session) throw new AuthorizationEnded();
  const refreshFetch = guardedFetch(env, job, false);
  let githubToken, cloudflareToken;
  try {
    githubToken = await getFreshAccessToken({ env, session, provider: 'github', fetchFn: refreshFetch });
    cloudflareToken = await getFreshAccessToken({ env, session, provider: 'cloudflare', fetchFn: refreshFetch });
  } catch (error) {
    if (error instanceof AuthorizationRefreshBusy || error instanceof JobStorageUnavailable) throw error;
    const detail = typeof error?.message === 'string' && /reconnect|expired|renewed|Connect /i.test(error.message)
      ? 'provider_token_refresh_failed'
      : 'provider_authorization_required';
    throw new AuthorizationEnded(detail);
  }
  const fetchFn = guardedFetch(env, job, true);
  await requireProviderAccess(() => verifyProviderConnections(input, {
    githubAccessToken: githubToken, cloudflareAccessToken: cloudflareToken,
    expectedGitHubUserId: job.github_user_id, fetchFn
  }));
  const assertCloudflareAccess = () => requireProviderAccess(() => verifyCloudflareAccount({
    accessToken: cloudflareToken, accountId: job.cloudflare_account_id, fetchFn, strict: true
  }));
  return { githubToken, cloudflareToken, fetchFn, assertCloudflareAccess };
}

async function performClaim(env, job) {
  let snapshot;
  try {
    snapshot = await approvalSnapshot(job, job.github_user_id);
  } catch {
    return await finishAttempt(env, job, 'approval_snapshot_mismatch');
  }
  if (snapshot.digest !== job.approval_digest || snapshot.slug !== job.site_slug)
    return await finishAttempt(env, job, 'approval_snapshot_mismatch');
  const { input } = snapshot;
  const connection = await verifiedConnections(env, job, input);
  const checkpoint = job.expected_commit_sha ? { repositoryId: job.repository_id,
    branch: job.production_branch, headCommitSha: job.expected_commit_sha, projectId: job.pages_project_id } : null;
  if (job.status === 'queued') {
    const provisioned = await applyWebsite(input, { ...connection, approved: {
      id: job.id, githubUserId: job.github_user_id, html: snapshot.html,
      allowLegacy: job.legacy_receipt_id !== null, checkpoint,
      assertCloudflareAccess: connection.assertCloudflareAccess,
      saveCheckpoint: async ({ repositoryId, branch, headCommitSha }) => {
        if (checkpoint) return; // applyWebsite already checked the recorded identity, branch and revision.
        await writeActiveClaim(env, job, 'repository_id = ?, production_branch = ?, expected_commit_sha = ?',
          [repositoryId, branch, headCommitSha]);
      }
    }});
    const time = clock();
    await writeActiveClaim(env, job, `status = 'pending_deployment', provisioned_at = ?, pages_project_id = ?,
      attempts = 0, updated_at = ?, next_attempt_at = ?, error_code = NULL, lease_id = NULL, lease_until = NULL`,
      [time, provisioned.pagesProjectId, time, time]);
    return;
  }
  const result = await verifyWebsite(input, {
    ...connection, expectedCommitSha: checkpoint.headCommitSha, approved: { ...checkpoint, html: snapshot.html }
  });
  if (result.status === 'live') {
    await writeActiveClaim(env, job, `status = 'live', updated_at = ?, error_code = NULL,
      lease_id = NULL, lease_until = NULL`, [clock()]);
  } else {
    const code = result.status === 'unexpected-public-content' ? 'approved_html_not_served' : 'approved_deployment_pending';
    await finishAttempt(env, job, code, { retryable: true });
  }
}

export async function runLaunchJob(env, id, sessionHash = null) {
  const job = await claimJob(env, id, sessionHash);
  if (!job) return;
  try {
    await performClaim(env, job);
  } catch (error) {
    if (error instanceof ClaimLost) return;
    if (error instanceof JobStorageUnavailable) throw error;
    if (error instanceof AuthorizationEnded || (error instanceof ProviderRequestError && error.authorizationLost)) {
      await pauseJob(env, job, error.code ?? 'provider_authorization_required');
      return;
    }
    try {
      if (error instanceof AuthorizationRefreshBusy) {
        await finishAttempt(env, job, 'provider_refresh_busy', { retryable: true });
      } else if (error instanceof ProviderRequestError) {
        await finishAttempt(env, job, error.retryable ? 'provider_unavailable' : 'provider_request_rejected', error);
      } else {
        await finishAttempt(env, job, 'launch_target_conflict');
      }
    } catch (writeError) {
      if (!(writeError instanceof ClaimLost)) throw writeError;
    }
  }
}

export async function runScheduledLaunches(env) {
  const time = clock();
  await env.DB.batch([
    env.DB.prepare(`UPDATE onboarding_launch_jobs SET status = 'needs_reauthorization',
      error_code = 'session_ended', updated_at = ?
      WHERE id IN (SELECT j.id FROM onboarding_launch_jobs j WHERE ${RUNNABLE}
        AND NOT ${HAS_APPROVAL} LIMIT ?)`).bind(time, time, SWEEP_LIMIT),
    env.DB.prepare(`UPDATE onboarding_launch_jobs SET status = 'failed',
      error_code = 'retry_budget_exhausted', updated_at = ?, lease_id = NULL, lease_until = NULL
      WHERE id IN (SELECT j.id FROM onboarding_launch_jobs j WHERE ${RUNNABLE}
        AND ${UNCLAIMED} AND j.attempts >= ? LIMIT ?)`).bind(time, time, MAX_ATTEMPTS, SWEEP_LIMIT),
    env.DB.prepare(`DELETE FROM onboarding_launch_jobs WHERE id IN (
      SELECT j.id FROM onboarding_launch_jobs j WHERE j.expires_at <= ? AND ${UNCLAIMED} LIMIT ?)`)
      .bind(time, time, SWEEP_LIMIT)
  ]);
  // One job per tick leaves room for both grant rotations inside Free-plan limits.
  const due = await env.DB.prepare(`SELECT j.id FROM onboarding_launch_jobs j WHERE ${RUNNABLE}
    AND j.next_attempt_at <= ? AND ${UNCLAIMED} AND j.attempts < ? AND j.expires_at > ?
    AND ${HAS_APPROVAL} ORDER BY j.next_attempt_at, j.id LIMIT 1`)
    .bind(time, time, MAX_ATTEMPTS, time + REQUEST_SECONDS, time + REQUEST_SECONDS).first();
  if (due) await runLaunchJob(env, due.id);
}
