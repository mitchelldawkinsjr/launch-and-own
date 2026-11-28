/** Review-only follow-up to a stored owner Analytics request. */
import {createHash} from 'node:crypto';
import {readPagesAnalyticsStatus} from '../pipeline/pages-analytics.mjs';
import {buildPagesAnalyticsEnablementPlan} from '../pipeline/pages-analytics-enablement-plan.mjs';
import {readManagedSiteBase} from '../pipeline/site-update-read.mjs';
import {validateStoredOptionApproval} from '../pipeline/stored-option-approval.mjs';
import {hasCurrentOwnerSession} from './launch-jobs.mjs';

const SITE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function siteForJob(job) {
  if (job.production_branch !== 'main' || !Number.isSafeInteger(job.repository_id) ||
      job.repository_id < 1 || typeof job.pages_project_id !== 'string' ||
      !PROJECT_ID.test(job.pages_project_id) || !SITE_SLUG.test(job.site_slug || '')) return null;
  const repositoryName = 'esp-' + job.site_slug;
  return Object.freeze({
    jobId: job.id,
    githubUserId: job.github_user_id,
    githubOwner: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    repositoryId: job.repository_id,
    repositoryName,
    pagesProjectId: job.pages_project_id,
    pagesProjectName: repositoryName + '-site',
    branch: job.production_branch
  });
}

export async function readOwnedAnalyticsConfiguration(env, current, job, cloudflareAccessToken, now) {
  const site = siteForJob(job);
  if (!site) return null;
  const principal = {githubUserId: current.github_user_id, cloudflareAccountId: current.cloudflare_account_id};
  return readPagesAnalyticsStatus({
    site, principal, cloudflareAccessToken,
    assertCurrentAuthorization: () => hasCurrentOwnerSession(env, current, now())
  });
}

async function readCurrentAnalyticsRow(env, current, site, time) {
  // One authorization snapshot covers the session epoch, current consent and
  // both exact site IDs, including during the final review check.
  return env.DB.prepare(
    'SELECT o.id, o.job_id, o.github_user_id, o.cloudflare_account_id, o.kind, ' +
    'o.approval_digest, o.payload_json, o.status FROM onboarding_option_approvals o ' +
    'JOIN onboarding_launch_jobs j ON j.id = o.job_id ' +
    'AND j.github_user_id = o.github_user_id AND j.cloudflare_account_id = o.cloudflare_account_id ' +
    'JOIN onboarding_sessions s ON s.github_user_id = o.github_user_id ' +
    'AND s.cloudflare_account_id = o.cloudflare_account_id ' +
    "WHERE o.job_id = ? AND o.kind = 'analytics' AND o.status = 'stored' " +
    'AND o.github_user_id = ? AND o.cloudflare_account_id = ? ' +
    "AND j.status = 'live' AND j.expires_at > ? AND j.repository_id = ? " +
    'AND j.pages_project_id = ? AND j.production_branch = ? ' +
    "AND 'esp-' || j.site_slug = ? AND j.github_login = ? " +
    'AND s.id_hash = ? AND s.authorization_epoch = ? AND s.expires_at > ? ' +
    'AND lower(s.github_login) = lower(j.github_login) AND s.github_token_ct IS NOT NULL ' +
    'AND s.cloudflare_token_ct IS NOT NULL'
  ).bind(site.jobId, current.github_user_id, current.cloudflare_account_id, time,
    site.repositoryId, site.pagesProjectId, site.branch, site.repositoryName, site.githubOwner,
    current.hash, current.authorization_epoch, time).first();
}

async function loadStoredRequest(env, current, job, site, time) {
  const row = await readCurrentAnalyticsRow(env, current, site, time);
  if (!row) return null;
  try {
    return validateStoredOptionApproval(row, {
      jobId: site.jobId,
      githubUserId: site.githubUserId,
      githubLogin: site.githubOwner,
      cloudflareAccountId: site.cloudflareAccountId,
      customerName: job.customer_name,
      pagesProjectName: site.pagesProjectName
    });
  } catch {
    return null;
  }
}

function requestFingerprint(stored, site) {
  const snapshot = [
    'launch-and-own-analytics-request-v1', stored.id, stored.digest, site.jobId,
    site.repositoryId, site.pagesProjectId, site.branch
  ];
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function currentAnalyticsRequestFingerprint(env, current, job, time) {
  const site = siteForJob(job);
  if (!site) return null;
  const stored = await loadStoredRequest(env, current, job, site, time);
  return stored ? requestFingerprint(stored, site) : null;
}

export async function reviewAnalyticsOptions(env, current, job, {
  fingerprint, privacyBeaconConsent, now, assertHistoryAccess
}) {
  const changed = {status: 'request-changed'};
  if (privacyBeaconConsent !== true) return {status: 'privacy-consent-required'};
  const site = siteForJob(job);
  if (!site) return changed;
  const storedOption = await loadStoredRequest(env, current, job, site, now());
  if (!storedOption || fingerprint !== requestFingerprint(storedOption, site)) return changed;

  async function stillCurrent() {
    const row = await readCurrentAnalyticsRow(env, current, site, now());
    return row?.id === storedOption.id &&
      row.approval_digest.toLowerCase() === storedOption.digest &&
      row.payload_json === storedOption.storedPayloadJson;
  }

  try {
    const {githubAccessToken, cloudflareAccessToken} = await assertHistoryAccess(env, current);
    const principal = {githubUserId: site.githubUserId, cloudflareAccountId: site.cloudflareAccountId};
    await readManagedSiteBase({
      name: job.customer_name,
      githubOwner: site.githubOwner,
      githubUserId: site.githubUserId,
      accountId: site.cloudflareAccountId,
      repositoryId: site.repositoryId
    }, {
      githubToken: githubAccessToken,
      fetchFn: async (url, options) => {
        if (!await stillCurrent()) throw Error('Analytics review authorization changed');
        return fetch(url, {...options, signal: AbortSignal.timeout(8000)});
      }
    });
    const configurationEvidence = await readPagesAnalyticsStatus({
      site, principal, cloudflareAccessToken, assertCurrentAuthorization: stillCurrent
    }, {includeReviewBinding: true});
    const review = await buildPagesAnalyticsEnablementPlan({
      storedOption, trustedSite: site, configurationEvidence, privacyBeaconConsent,
      assertCurrentAuthorization: stillCurrent
    });
    return await stillCurrent() ? review : changed;
  } catch {
    return {status: 'site-review-unavailable'};
  }
}
