// #85: review-only Pages Web Analytics enablement plan.
// Consumes a stored analytics opt-in + trusted site + read-only configuration
// evidence. NEVER PATCHes Pages, creates RUM sites, redeploys, or returns tokens.
import {createHash} from 'node:crypto';
import {buildAnalyticsOptInReview} from './option-feature-review.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PROJECT = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*-site$/;
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const CONFIGS = new Set(['not_observed', 'tag_reported_activation_unverified']);

const NOTICES = Object.freeze([
  'Enabling Web Analytics may inject a client-side performance/traffic beacon on the next deployment.',
  'A Pages project tag is configuration evidence only; it does not prove the beacon is live or that traffic was measured.',
  'Empty analytics is not verified zero traffic. Metrics require a separate authorized query after enablement and deployment.',
  'This plan does not PATCH Cloudflare, create a RUM site, redeploy Pages, or claim activation.'
]);

function deny(status, reason) {
  return Object.freeze({
    status, reason, proposalSha256: null, notices: Object.freeze([]),
    binding: null, configuration: 'unknown', proposedMethod: null,
    publicationVerified: false, beaconVerified: false, metricsQueried: false,
    requiresOwnerApproval: true, requiresOperatorGrant: true,
    readyForProviderWrite: false
  });
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function siteOk(site) {
  return site && UUID.test(site.jobId || '') && positive(site.githubUserId) &&
    positive(site.repositoryId) && ACCOUNT.test(site.cloudflareAccountId || '') &&
    typeof site.pagesProjectId === 'string' && PROJECT_ID.test(site.pagesProjectId) &&
    PROJECT.test(site.pagesProjectName || '') && site.branch === 'main';
}

function storedAnalyticsOptIn(option, site) {
  if (!option || !UUID.test(option.id || '') || option.jobId !== site.jobId ||
      option.kind !== 'analytics' || option.status !== 'stored' ||
      option.canWrite !== false || option.canActivate !== false ||
      !positive(option.githubUserId) || option.githubUserId !== site.githubUserId ||
      option.cloudflareAccountId !== site.cloudflareAccountId ||
      !DIGEST.test(option.digest || '')) return null;
  const review = buildAnalyticsOptInReview({
    githubUserId: site.githubUserId,
    cloudflareAccountId: site.cloudflareAccountId,
    pagesProjectName: site.pagesProjectName,
    analyticsConsent: true
  });
  if (review.status !== 'awaiting_analytics_opt_in' ||
      review.approvalDigest !== option.digest ||
      review.plan.pagesProjectName !== site.pagesProjectName) return null;
  return review;
}

function configurationOk(evidence, site) {
  // Caller supplies the safe projection from readPagesAnalyticsStatus (or equal).
  // Reject raw provider payloads, secrets, and invented active states.
  if (!evidence || evidence.feature !== 'cloudflare_web_analytics' ||
      evidence.state !== 'manual_setup' || !CONFIGS.has(evidence.configuration) ||
      evidence.metrics?.status !== 'not_queried' ||
      evidence.metrics?.visitors != null || evidence.metrics?.pageviews != null ||
      evidence.analyticsDashboardUrl != null) return false;
  if (typeof evidence.projectDashboardUrl !== 'string') return false;
  const expected = 'https://dash.cloudflare.com/' + site.cloudflareAccountId +
    '/pages/view/' + site.pagesProjectName;
  return evidence.projectDashboardUrl === expected;
}

/**
 * Builds an exact enablement review record for a later operator-gated apply.
 *
 * Inputs must come from server-side D1/session inventory and the read-only
 * analytics adapter. Browser/agent payloads are not trusted. Output never
 * includes web_analytics_tag, web_analytics_token, or a provider write body.
 */
export async function buildPagesAnalyticsEnablementPlan(input = {}) {
  const keys = ['storedOption', 'trustedSite', 'configurationEvidence',
    'privacyBeaconConsent'];
  let original, data;
  try {
    original = keys.map(key => JSON.stringify(input[key]));
    if (original.some(value => value === undefined))
      return deny('blocked-missing-evidence',
        'Stored analytics opt-in, trusted site, and configuration evidence are required');
    data = structuredClone(Object.fromEntries(keys.map(key => [key, input[key]])));
  } catch {
    return deny('blocked-invalid-evidence', 'Invalid enablement review snapshot');
  }

  const {storedOption, trustedSite, configurationEvidence, privacyBeaconConsent} = data;
  if (!siteOk(trustedSite))
    return deny('blocked-site-identity',
      'Current owned job, GitHub identity, and Pages project are required');
  const review = storedAnalyticsOptIn(storedOption, trustedSite);
  if (!review)
    return deny('blocked-stored-approval',
      'An exact, current, owner-scoped stored analytics opt-in is required');
  if (privacyBeaconConsent !== true)
    return deny('blocked-privacy-consent',
      'Separate owner consent for beacon injection and privacy notice is required');
  if (!configurationOk(configurationEvidence, trustedSite))
    return deny('blocked-configuration-evidence',
      'Trusted read-only Pages analytics configuration evidence is required');
  if (configurationEvidence.configuration === 'tag_reported_activation_unverified')
    return deny('manual-review-required',
      'A Web Analytics tag is already reported; verify beacon and metrics separately');
  if (typeof input.assertCurrentAuthorization !== 'function')
    return deny('blocked-authorization', 'A server-side current-owner fence is required');

  let authorized = false;
  try { authorized = await input.assertCurrentAuthorization() === true; } catch {}
  if (!authorized)
    return deny('blocked-authorization', 'Owner session was revoked');

  const binding = Object.freeze({
    jobId: trustedSite.jobId,
    githubUserId: trustedSite.githubUserId,
    repositoryId: trustedSite.repositoryId,
    cloudflareAccountId: trustedSite.cloudflareAccountId.toLowerCase(),
    pagesProjectId: trustedSite.pagesProjectId,
    pagesProjectName: trustedSite.pagesProjectName,
    storedOptionId: storedOption.id,
    storedApprovalDigest: storedOption.digest
  });
  const proposalSha256 = digest({
    kind: 'launch-and-own-pages-analytics-enablement-v1',
    binding,
    configuration: configurationEvidence.configuration,
    privacyBeaconConsent: true,
    proposedMethod: 'pages_metrics_enable_after_operator_grant',
    notices: NOTICES
  });

  let unchanged = false;
  try { unchanged = keys.every((key, i) => JSON.stringify(input[key]) === original[i]); }
  catch {}
  let stillAuthorized = false;
  try { stillAuthorized = await input.assertCurrentAuthorization() === true; } catch {}
  if (!unchanged || !stillAuthorized)
    return deny('blocked-review-context-changed',
      'The owner, grant, or evidence changed while preparing the enablement review');

  return Object.freeze({
    status: 'review-required',
    reason: 'Review exact Pages Web Analytics enablement before any provider write',
    proposalSha256,
    notices: NOTICES,
    binding,
    configuration: configurationEvidence.configuration,
    proposedMethod: 'pages_metrics_enable_after_operator_grant',
    projectDashboardUrl: configurationEvidence.projectDashboardUrl,
    publicationVerified: false,
    beaconVerified: false,
    metricsQueried: false,
    requiresOwnerApproval: true,
    requiresOperatorGrant: true,
    readyForProviderWrite: false
  });
}
