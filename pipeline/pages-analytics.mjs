// Issue #85: read-only Cloudflare Pages Web Analytics configuration for a
// trusted, session-fenced managed site. No enablement, beacon, metrics, or writes.
import {matchesApprovedPagesProject} from './approved-pages-project.mjs';

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const MANAGED_REPO = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_OWNER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const CANONICAL_ID = /^[1-9][0-9]*$/;

function sameGitHubId(value, expected) {
  return (typeof value === 'string' || typeof value === 'number') &&
    CANONICAL_ID.test(String(value)) && Number.isSafeInteger(Number(value)) &&
    Number.isSafeInteger(expected) && expected > 0 && String(value) === String(expected);
}

function snapshotIdentity(site, principal) {
  // Both arguments must be derived by the server from verified sessions and
  // current #39 site inventory. Never accept browser-/model-provided identifiers.
  if (!site || !principal || !Number.isSafeInteger(site.githubUserId) || site.githubUserId < 1 ||
      !Number.isSafeInteger(principal.githubUserId) || principal.githubUserId !== site.githubUserId ||
      typeof site.cloudflareAccountId !== 'string' || !ACCOUNT_ID.test(site.cloudflareAccountId) ||
      principal.cloudflareAccountId !== site.cloudflareAccountId ||
      !Number.isSafeInteger(site.repositoryId) || site.repositoryId < 1 ||
      typeof site.githubOwner !== 'string' || !GITHUB_OWNER.test(site.githubOwner) ||
      typeof site.repositoryName !== 'string' || !MANAGED_REPO.test(site.repositoryName) ||
      site.pagesProjectName !== site.repositoryName + '-site' ||
      typeof site.pagesProjectId !== 'string' || !site.pagesProjectId.trim() ||
      site.branch !== 'main')
    throw Error('A verified, owner-scoped managed site is required');
  return Object.freeze({
    githubUserId: site.githubUserId, cloudflareAccountId: site.cloudflareAccountId,
    githubOwner: site.githubOwner, repositoryId: site.repositoryId,
    repositoryName: site.repositoryName, pagesProjectName: site.pagesProjectName,
    pagesProjectId: site.pagesProjectId, branch: site.branch
  });
}

function stillSameInput(site, principal, trusted) {
  return principal?.githubUserId === trusted.githubUserId &&
    principal?.cloudflareAccountId === trusted.cloudflareAccountId &&
    Object.keys(trusted).every(key => site?.[key] === trusted[key]);
}

function noMetrics() {
  // Missing analytics results must never be described as measured zero traffic.
  return {status: 'not_queried', visitors: null, pageviews: null,
    referrers: null, topPages: null, coreWebVitals: null};
}

function unavailable(state, reason) {
  return {feature: 'cloudflare_web_analytics', state, reason,
    configuration: 'unknown', metrics: noMetrics(), action: null,
    projectDashboardUrl: null, analyticsDashboardUrl: null};
}

/**
 * Read-only provider status after a caller-established authorization fence.
 *
 * site: trusted current #39 managed-site record, not a request/agent payload
 * principal: current authenticated provider-linked session IDs
 * assertCurrentAuthorization(snapshot): MUST independently re-read the live
 *   backend authorization epoch, provider grants and selected owner/account.
 *   Return true only while this exact owner/site remains authorized.
 *   Invoked before the GET and again after the provider read/JSON await.
 * cloudflareAccessToken: refreshed, backend-only OAuth access token
 *
 * Returned data is a safe customer-facing projection, never raw provider data.
 */
export async function readPagesAnalyticsStatus({
  site, principal, cloudflareAccessToken, assertCurrentAuthorization, fetchFn = fetch
}) {
  const trusted = snapshotIdentity(site, principal);
  if (typeof assertCurrentAuthorization !== 'function')
    return unavailable('blocked_permission_or_plan', 'authorization_fence_required');

  async function authorized() {
    if (!stillSameInput(site, principal, trusted)) return false;
    try {
      // Give the caller a copy of immutable values; never provide access tokens.
      const result = await assertCurrentAuthorization(trusted);
      return result === true && stillSameInput(site, principal, trusted);
    } catch {
      // Do not include D1, OAuth, authorization epoch, or provider exception text.
      return false;
    }
  }
  if (!await authorized())
    return unavailable('blocked_permission_or_plan', 'authorization_changed_or_expired');
  if (typeof cloudflareAccessToken !== 'string' || !cloudflareAccessToken.trim())
    return unavailable('blocked_permission_or_plan', 'cloudflare_reauthentication_required');

  const url = 'https://api.cloudflare.com/client/v4/accounts/' + trusted.cloudflareAccountId +
    '/pages/projects/' + trusted.pagesProjectName;
  let response;
  try {
    response = await fetchFn(url, {method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {authorization: 'Bearer ' + cloudflareAccessToken, accept: 'application/json'}});
  } catch {
    // Transport messages can contain provider URLs or credentials: do not echo.
    return unavailable('not_available', 'cloudflare_temporarily_unavailable');
  }
  if (!await authorized())
    return unavailable('blocked_permission_or_plan', 'authorization_changed_or_expired');

  if (response?.status === 401)
    return unavailable('blocked_permission_or_plan', 'cloudflare_reauthentication_required');
  if (response?.status === 403) {
    if (response.headers?.get('retry-after') ||
        response.headers?.get('x-ratelimit-remaining') === '0')
      return unavailable('not_available', 'cloudflare_rate_limited');
    return unavailable('blocked_permission_or_plan', 'cloudflare_permission_denied');
  }
  if (response?.status === 404)
    return unavailable('not_available', 'managed_pages_project_not_accessible');
  if (response?.status === 429)
    return unavailable('not_available', 'cloudflare_rate_limited');
  if (!response?.ok)
    return unavailable('not_available', 'cloudflare_temporarily_unavailable');

  let body;
  try { body = await response.json(); }
  catch { return unavailable('not_available', 'cloudflare_unexpected_response'); }
  if (!await authorized())
    return unavailable('blocked_permission_or_plan', 'authorization_changed_or_expired');
  if (body?.success !== true || !body.result || typeof body.result !== 'object')
    return unavailable('not_available', 'cloudflare_unexpected_response');

  const project = body.result;
  const config = project.source?.config;
  // #95 extends the shared matcher with ownerId. Keep an explicit local fence
  // until Sol's independent PR is integrated, including on the existing main.
  if (!sameGitHubId(config?.repo_id, trusted.repositoryId) ||
      (config?.owner_id != null && !sameGitHubId(config.owner_id, trusted.githubUserId)) ||
      !matchesApprovedPagesProject(project, {
        name: trusted.pagesProjectName, projectId: trusted.pagesProjectId,
        owner: trusted.githubOwner, ownerId: trusted.githubUserId,
        repositoryName: trusted.repositoryName, repositoryId: trusted.repositoryId,
        branch: trusted.branch
      })) {
    throw Error('Pages project no longer matches the verified managed site');
  }

  // This is the documented Pages project field. An observed tag is only
  // configuration evidence, NOT proof of beacon injection, access, or visits.
  const tag = project.build_config?.web_analytics_tag;
  const configuration = typeof tag === 'string' && tag.trim()
    ? 'tag_reported_activation_unverified' : 'not_observed';
  return {
    feature: 'cloudflare_web_analytics', state: 'manual_setup',
    reason: configuration === 'not_observed' ? 'review_cloudflare_analytics_settings' :
      'review_cloudflare_beacon_and_metrics',
    configuration, metrics: noMetrics(),
    action: 'Review Web Analytics settings in your verified Cloudflare Pages project: ' +
      'Metrics > Web Analytics. Activation may inject a beacon on the next deployment ' +
      'and must pass separate privacy consent and exact-publication verification.',
    projectDashboardUrl: 'https://dash.cloudflare.com/' + trusted.cloudflareAccountId +
      '/pages/view/' + trusted.pagesProjectName,
    // Global dashboard routes are not independently verified for this account.
    analyticsDashboardUrl: null
  };
}
