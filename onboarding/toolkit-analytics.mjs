/** Owner-facing Pages Web Analytics status and manual setup (#85). */
import {readPagesAnalyticsStatus} from '../pipeline/pages-analytics.mjs';

const PROJECT_DASHBOARD = /^https:\/\/dash\.cloudflare\.com\/[a-fA-F0-9]{32}\/pages\/view\/esp-[a-z0-9]+(?:-[a-z0-9]+)*-site$/;

const CONFIGURATION_COPY = Object.freeze({
  not_observed: 'Cloudflare has yet to report a Web Analytics tag for this Pages project.',
  tag_reported_activation_unverified:
    'Cloudflare reports Web Analytics configuration. The live beacon and traffic still need verification.'
});

const UNAVAILABLE_COPY = Object.freeze({
  authorization_fence_required: 'Reconnect your accounts to check Web Analytics for this site.',
  authorization_changed_or_expired: 'Reconnect your accounts to check Web Analytics for this site.',
  cloudflare_reauthentication_required: 'Sign in to Cloudflare again to check Web Analytics for this site.',
  cloudflare_permission_denied: 'Your Cloudflare connection needs permission to read this Pages project.',
  cloudflare_rate_limited: 'Cloudflare paused this check because of its request limit. Try again later.'
});

/**
 * Call with the verified current site, server-side token, and live owner
 * authorization fence from the toolkit route.
 */
export async function loadToolkitAnalytics(request) {
  try {
    const result = await readPagesAnalyticsStatus(request);
    return Object.freeze({
      state: result.state,
      reason: result.reason,
      configuration: result.configuration,
      projectDashboardUrl: result.projectDashboardUrl
    });
  } catch {
    return Object.freeze({
      state: 'not_available',
      reason: 'analytics_site_unavailable',
      configuration: 'unknown',
      projectDashboardUrl: null
    });
  }
}

export function renderToolkitAnalytics(status, {escape}) {
  const heading = '<section><h2>Web Analytics</h2>';
  const url = status?.projectDashboardUrl;
  if (status?.state !== 'manual_setup' ||
      !Object.hasOwn(CONFIGURATION_COPY, status.configuration) ||
      typeof url !== 'string' || !PROJECT_DASHBOARD.test(url)) {
    const message = Object.hasOwn(UNAVAILABLE_COPY, status?.reason)
      ? UNAVAILABLE_COPY[status.reason]
      : 'Web Analytics settings could not be verified for this site.';
    return heading + '<p>' + message + '</p></section>';
  }

  return heading + '<p>' + CONFIGURATION_COPY[status.configuration] + '</p>' +
    '<p>Traffic data is unavailable in the toolkit. Open this project in Cloudflare and choose ' +
    '<strong>Metrics → Web Analytics</strong> to review its settings.</p>' +
    '<p>Review your plan limits and site privacy notice before opting in. Enabling Web Analytics ' +
    'may add a browser beacon on your next deployment. Review and approve that deployment separately.</p>' +
    '<p><a href="' + escape(url) + '" rel="noreferrer">Open Cloudflare project</a></p></section>';
}
