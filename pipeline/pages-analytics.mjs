// Issue #85: read-only Cloudflare Pages Web Analytics eligibility for a *trusted*
// server-side managed-site identity. This module does not enable analytics,
// inject beacons, read visitor statistics, or make provider writes.
import {matchesApprovedPagesProject} from './approved-pages-project.mjs';
import {ProviderRequestError} from './provider-errors.mjs';

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const MANAGED_REPO = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_OWNER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

function requireManagedIdentity(site, principal) {
  // BOTH arguments must be derived by the server from verified session + #39
  // managed-site inventory. Never pass browser-supplied account/repository IDs.
  if (!site || !principal || !Number.isSafeInteger(site.githubUserId) || site.githubUserId < 1 ||
      !Number.isSafeInteger(principal.githubUserId) || principal.githubUserId !== site.githubUserId ||
      typeof site.cloudflareAccountId !== 'string' || !ACCOUNT_ID.test(site.cloudflareAccountId) ||
      principal.cloudflareAccountId !== site.cloudflareAccountId ||
      !Number.isSafeInteger(site.repositoryId) || site.repositoryId < 1 ||
      typeof site.githubOwner !== 'string' || !GITHUB_OWNER.test(site.githubOwner) ||
      typeof site.repositoryName !== 'string' || !MANAGED_REPO.test(site.repositoryName) ||
      site.pagesProjectName !== site.repositoryName + '-site' ||
      typeof site.pagesProjectId !== 'string' || !site.pagesProjectId.trim() ||
      site.branch !== 'main') {
    throw Error('A verified, owner-scoped managed site is required');
  }
}

function noMetrics() {
  // Deliberately no "zero" counts: absence of reporting is not verified zero traffic.
  return {status: 'not_queried', visitors: null, pageviews: null, referrers: null,
    topPages: null, coreWebVitals: null};
}

function unavailable(state, reason) {
  return {feature: 'cloudflare_web_analytics', state, reason,
    configuration: 'unknown', metrics: noMetrics(), action: null,
    projectDashboardUrl: null, analyticsDashboardUrl: null};
}

/**
 * @param {object} args
 * @param {object} args.site - Trusted server-side #39 inventory record, never request JSON.
 * @param {object} args.principal - Current authenticated session identities after token refresh/revocation fence.
 * @param {string} args.cloudflareAccessToken - Server-side OAuth token; never serialized.
 * @param {function} [args.fetchFn] - Injected GET transport for tests.
 * @returns {Promise<object>} Sanitized, status-only UI contract. Never includes provider responses or telemetry.
 */
export async function readPagesAnalyticsStatus({site, principal, cloudflareAccessToken, fetchFn = fetch}) {
  requireManagedIdentity(site, principal);
  if (typeof cloudflareAccessToken !== 'string' || !cloudflareAccessToken.trim())
    return unavailable('blocked_permission_or_plan', 'cloudflare_reauthentication_required');

  const url = 'https://api.cloudflare.com/client/v4/accounts/' + site.cloudflareAccountId +
    '/pages/projects/' + site.pagesProjectName;
  const response = await fetchFn(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: {authorization: 'Bearer ' + cloudflareAccessToken, accept: 'application/json'}
  });
  // 403 can signal throttling too. Distinguish retryable provider limits
  // from revocation, so a transient rate limit never appears as lost consent.
  if (response.status === 403 &&
      (response.headers.get('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))
    throw new ProviderRequestError(response);
  if (response.status === 401 || response.status === 403)
    return unavailable('blocked_permission_or_plan', 'cloudflare_access_denied');
  if (response.status === 404)
    return unavailable('not_available', 'managed_pages_project_not_accessible');
  if (!response.ok) throw new ProviderRequestError(response);

  let body;
  try { body = await response.json(); }
  catch { throw Error('Cloudflare Pages project verification unavailable'); }
  if (body?.success !== true || !body.result || typeof body.result !== 'object')
    throw Error('Cloudflare Pages project verification unavailable');

  const project = body.result;
  if (!matchesApprovedPagesProject(project, {
    name: site.pagesProjectName, projectId: site.pagesProjectId,
    owner: site.githubOwner, repositoryName: site.repositoryName,
    repositoryId: site.repositoryId, branch: site.branch
  })) {
    // Do not link to another owner's project or expose its metadata, including
    // Cloudflare's web_analytics_token, environment variables, and build data.
    throw Error('Pages project no longer matches the verified managed site');
  }

  const tag = project.web_analytics_tag ?? project.build_config?.web_analytics_tag;
  const configuration = typeof tag === 'string' && tag.trim()
    ? 'tag_reported_activation_unverified' : 'not_observed';
  return {
    feature: 'cloudflare_web_analytics',
    state: 'manual_setup',
    reason: configuration === 'not_observed' ? 'open_cloudflare_to_check_or_enable' :
      'open_cloudflare_to_confirm_beacon_and_metrics',
    configuration,
    metrics: noMetrics(),
    action: 'Open your verified Pages project, choose Metrics > Web Analytics, and review or enable it. ' +
      'Cloudflare injects the analytics beacon on the next deployment after enablement. ' +
      'Before enabling, review your site privacy notice and consent requirements.',
    projectDashboardUrl: 'https://dash.cloudflare.com/' + site.cloudflareAccountId +
      '/pages/view/' + site.pagesProjectName,
    // The global Web Analytics path differs across Cloudflare dashboard releases.
    // Do not expose a speculative :account placeholder as a working deep link.
    analyticsDashboardUrl: null
  };
}
