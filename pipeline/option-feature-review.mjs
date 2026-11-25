// Digest-bound opt-in reviews for Web Analytics, PR previews, SEO, and redirects.
// Store-only. Never enables a beacon, Page Rule, SEO PR, or preview setting.
import { createHash } from 'node:crypto';
import { UPDATE_BRANCH_PATTERN, previewExposureNotice } from './pages-preview-policy.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const PROJECT = /^(esp-[a-z0-9]+(?:-[a-z0-9]+)*)-site$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;
const PATH = /^\/[a-z0-9._~/-]{0,200}$/i;
const WWW_MODES = new Set(['none', 'apex_to_www', 'www_to_apex']);

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(plan) {
  return createHash('sha256').update(stableJson(plan), 'utf8').digest('hex');
}

function ownerOk(githubUserId, cloudflareAccountId, pagesProjectName) {
  return Number.isSafeInteger(githubUserId) && githubUserId > 0 &&
    typeof cloudflareAccountId === 'string' && ACCOUNT.test(cloudflareAccountId) &&
    typeof pagesProjectName === 'string' && PROJECT.test(pagesProjectName);
}

/** Owner asks to review enabling Pages Web Analytics later. Does not activate. */
export function buildAnalyticsOptInReview({
  githubUserId, cloudflareAccountId, pagesProjectName, analyticsConsent
} = {}) {
  if (!ownerOk(githubUserId, cloudflareAccountId, pagesProjectName))
    return Object.freeze({
      status: 'blocked', reason: 'verified_owner_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (analyticsConsent !== true)
    return Object.freeze({
      status: 'blocked', reason: 'analytics_owner_consent_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const plan = Object.freeze({
    kind: 'launch-and-own-analytics-opt-in',
    version: 1,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    pagesProjectName,
    proposed: Object.freeze({ feature: 'cloudflare_web_analytics', activation: 'manual_or_later_apply' }),
    notices: Object.freeze([
      'This request does not enable Web Analytics or inject a beacon.',
      'A later apply may change Pages Metrics settings on this project only.',
      'Review Cloudflare Pages → Metrics → Web Analytics before activation.'
    ]),
    canActivate: false,
    canWrite: false
  });
  return Object.freeze({
    status: 'awaiting_analytics_opt_in',
    plan,
    approvalDigest: digest(plan),
    canActivate: false,
    canWrite: false
  });
}

/**
 * Owner asks to review scoped PR preview builds later.
 * Requires acknowledging that draft preview URLs can be public.
 */
export function buildPreviewOptInReview({
  githubUserId, cloudflareAccountId, pagesProjectName, previewConsent, acknowledgePublicPreviews
} = {}) {
  if (!ownerOk(githubUserId, cloudflareAccountId, pagesProjectName))
    return Object.freeze({
      status: 'blocked', reason: 'verified_owner_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (previewConsent !== true)
    return Object.freeze({
      status: 'blocked', reason: 'preview_owner_consent_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (acknowledgePublicPreviews !== true)
    return Object.freeze({
      status: 'blocked', reason: 'public_preview_acknowledgement_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const plan = Object.freeze({
    kind: 'launch-and-own-preview-opt-in',
    version: 1,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    pagesProjectName,
    proposed: Object.freeze({
      preview_deployment_setting: 'custom',
      preview_branch_includes: Object.freeze([UPDATE_BRANCH_PATTERN]),
      preview_branch_excludes: Object.freeze(['main']),
      pr_comments_enabled: false
    }),
    notices: Object.freeze(previewExposureNotice()),
    canActivate: false,
    canWrite: false,
    accessPolicyRequired: true
  });
  return Object.freeze({
    status: 'awaiting_preview_opt_in',
    plan,
    approvalDigest: digest(plan),
    canActivate: false,
    canWrite: false
  });
}

/** Owner asks to review a static SEO starter pack later. Does not open a PR. */
export function buildSeoOptInReview({
  githubUserId, cloudflareAccountId, pagesProjectName, seoConsent
} = {}) {
  if (!ownerOk(githubUserId, cloudflareAccountId, pagesProjectName))
    return Object.freeze({
      status: 'blocked', reason: 'verified_owner_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (seoConsent !== true)
    return Object.freeze({
      status: 'blocked', reason: 'seo_owner_consent_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const plan = Object.freeze({
    kind: 'launch-and-own-seo-opt-in',
    version: 1,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    pagesProjectName,
    proposed: Object.freeze({
      feature: 'static_seo_starter',
      artifacts: Object.freeze(['canonical', 'open_graph', 'robots.txt', 'sitemap.xml']),
      activation: 'owner_reviewed_git_pr_later'
    }),
    notices: Object.freeze([
      'This request does not edit HTML, robots.txt, or sitemap.xml.',
      'A later SEO change still needs verified origin evidence and an owner-reviewed Git PR.',
      'ZIP or custom sites stay manual-review-only and are never rewritten silently.'
    ]),
    canActivate: false,
    canWrite: false
  });
  return Object.freeze({
    status: 'awaiting_seo_opt_in',
    plan,
    approvalDigest: digest(plan),
    canActivate: false,
    canWrite: false
  });
}

function hostnameOk(raw) {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  if (!HOST.test(host) || host.length > 253 || host.endsWith('.pages.dev')) return null;
  if (/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return null;
  return host;
}

function pathRules(pathFrom, pathTo, host) {
  if ((pathFrom == null || pathFrom === '') && (pathTo == null || pathTo === ''))
    return [];
  if (!PATH.test(pathFrom || '') || !PATH.test(pathTo || '') || pathFrom === pathTo)
    return null;
  if (String(pathFrom).includes('//') || String(pathTo).includes('//')) return null;
  return Object.freeze([{from: pathFrom, to: pathTo, host, status: 301}]);
}

/**
 * Owner asks to review same-host redirects later.
 * Never creates Cloudflare Page Rules, Bulk Redirects, or DNS records.
 */
export function buildRedirectOptInReview({
  githubUserId, cloudflareAccountId, hostname, redirectConsent,
  wwwMode = 'none', pathFrom, pathTo
} = {}) {
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0 ||
      typeof cloudflareAccountId !== 'string' || !ACCOUNT.test(cloudflareAccountId))
    return Object.freeze({
      status: 'blocked', reason: 'verified_owner_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (redirectConsent !== true)
    return Object.freeze({
      status: 'blocked', reason: 'redirect_owner_consent_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const host = hostnameOk(hostname);
  if (!host)
    return Object.freeze({
      status: 'blocked', reason: 'verified_custom_hostname_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (!WWW_MODES.has(wwwMode))
    return Object.freeze({
      status: 'blocked', reason: 'www_mode_invalid', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const rules = pathRules(pathFrom, pathTo, host);
  if (!rules)
    return Object.freeze({
      status: 'blocked', reason: 'redirects_must_stay_on_the_same_host', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  if (wwwMode === 'none' && rules.length === 0)
    return Object.freeze({
      status: 'blocked', reason: 'redirect_rule_required', approvalDigest: null,
      canActivate: false, canWrite: false
    });
  const plan = Object.freeze({
    kind: 'launch-and-own-redirect-opt-in',
    version: 1,
    githubUserId,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    hostname: host,
    proposed: Object.freeze({
      wwwMode,
      pathRules: rules,
      premiumWafIncluded: false
    }),
    notices: Object.freeze([
      'This request does not create Page Rules, Bulk Redirects, or DNS records.',
      'Same-host path redirects only; off-host targets are rejected.',
      'Apex/www preference still needs Domain-approved DNS or redirect configuration.',
      'Pages Free DDoS coverage is not a paid WAF/bot claim.'
    ]),
    canActivate: false,
    canWrite: false
  });
  return Object.freeze({
    status: 'awaiting_redirect_opt_in',
    plan,
    approvalDigest: digest(plan),
    canActivate: false,
    canWrite: false
  });
}
