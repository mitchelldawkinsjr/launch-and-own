// Reusable, deterministic provisioning plan. No account changes or secret handling.
// Usage: node pipeline/plan-customer.mjs customer.json
import { createHash } from 'node:crypto';

export const TURNSTILE_FREE_LIMITS = Object.freeze({
  widgetsPerAccount: 20,
  hostnamesPerWidget: 10,
  challenges: 'unlimited',
  tokenTtlSeconds: 300,
  siteverifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  docs: Object.freeze([
    'https://developers.cloudflare.com/turnstile/plans/',
    'https://developers.cloudflare.com/turnstile/get-started/server-side-validation/',
    'https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/'
  ])
});

const NEVER_ACTIVATE = Object.freeze({
  createResources: false,
  canActivate: false,
  canWrite: false,
  workingForm: false,
  widgetAloneInsufficient: true
});

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function slugify(value) {
  return String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
}

function formsReviewFor(planCore) {
  const body = Object.freeze({
    kind: 'launch-and-own-forms-review',
    version: 1,
    customer: planCore.customer,
    accountId: planCore.accountId,
    githubOwner: planCore.githubOwner,
    domain: planCore.domain,
    ownerEmail: planCore.ownerEmail,
    delivery: 'customer-owned-d1-and-worker',
    siteverify: Object.freeze({
      required: true,
      url: TURNSTILE_FREE_LIMITS.siteverifyUrl,
      tokenTtlSeconds: TURNSTILE_FREE_LIMITS.tokenTtlSeconds,
      singleUse: true,
      secretSource: 'customer_owned_turnstile_widget_secret',
      rejectOn: Object.freeze([
        'missing-input-secret',
        'missing-input-response',
        'invalid-input-response',
        'timeout-or-duplicate',
        'bad-request',
        'internal-error'
      ])
    }),
    abuseControls: Object.freeze({
      requireMatchingHostname: true,
      maxHostnamesPerWidget: TURNSTILE_FREE_LIMITS.hostnamesPerWidget,
      maxWidgetsPerAccount: TURNSTILE_FREE_LIMITS.widgetsPerAccount
    }),
    storageGate: Object.freeze({
      d1AndWorkers: 'separate_cost_and_privacy_review_required',
      relatedIssue: '#89'
    }),
    ...NEVER_ACTIVATE,
    notices: Object.freeze([
      'A Turnstile client widget without server-side Siteverify is not a working contact form.',
      'Do not store Turnstile secrets in Git, chat, or customer HTML.',
      'D1/Workers form storage still needs separate #89 cost and privacy approval before any create.',
      'mode=plan-only: this object never creates Cloudflare resources.'
    ])
  });
  return Object.freeze({
    ...body,
    approvalDigest: createHash('sha256').update(stableJson(body), 'utf8').digest('hex'),
    freeLimits: TURNSTILE_FREE_LIMITS
  });
}

/**
 * Plan-only customer provisioning. When forms=true, attaches a Siteverify-bound
 * formsReview. Never activates forms from a widget alone and never writes providers.
 */
export function planCustomer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Customer configuration must be an object');
  const {
    name, accountId, githubOwner, forms = false, ownerEmail, hostname, formsConsent
  } = input;
  if (typeof name !== 'string' || !name.trim()) throw Error('Customer name is required');
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId))
    throw Error('Valid Cloudflare account ID is required');
  if (typeof githubOwner !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubOwner))
    throw Error('Valid GitHub owner is required');
  if (typeof forms !== 'boolean') throw Error('forms must be a boolean');
  // forms:true still builds the step DAG so website-only verifiers can reject early.
  // A digest-ready formsReview requires explicit formsConsent.
  if (forms && (typeof ownerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)))
    throw Error('Valid ownerEmail required for forms');
  if (formsConsent !== undefined && formsConsent !== true && formsConsent !== false)
    throw Error('formsConsent must be a boolean');
  if (hostname !== undefined && (typeof hostname !== 'string'
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) || !hostname.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(hostname)
      || hostname.includes('/') || hostname.includes(':') || hostname.includes('*')))
    throw Error('Invalid hostname');
  const slug = slugify(name);
  if (!slug) throw Error('Customer name must contain letters or numbers');
  const prefix = 'esp-' + slug;
  const pages = prefix + '-site';
  const domain = hostname || pages + '.pages.dev';
  const steps = [
    { id: 'github', resource: 'github-repository', name: prefix, requires: [] },
    { id: 'pages', resource: 'cloudflare-pages', name: pages, requires: ['github'] },
    { id: 'deploy', resource: 'pages-deployment', name: domain, requires: ['pages'] }
  ];
  if (forms) {
    steps.push(
      { id: 'd1', resource: 'cloudflare-d1', name: prefix + '-forms', requires: [],
        gate: 'issue-89-cost-privacy-review' },
      { id: 'turnstile', resource: 'cloudflare-turnstile', name: prefix + '-contact', requires: [],
        gate: 'server-side-siteverify-required' },
      { id: 'worker', resource: 'cloudflare-worker', name: prefix + '-forms',
        requires: ['d1', 'turnstile'], gate: 'issue-89-cost-privacy-review' },
      { id: 'access', resource: 'cloudflare-access', name: prefix + '-admin', requires: ['worker'] },
      { id: 'form-deploy', resource: 'form-enabled-pages-deployment', name: domain,
        requires: ['worker', 'access', 'deploy'] },
      { id: 'acceptance', resource: 'human-verified-form-and-dashboard-test', name: domain,
        requires: ['form-deploy'] }
    );
  }

  const planCore = {
    version: 1,
    mode: 'plan-only',
    customer: slug,
    accountId,
    githubOwner,
    domain,
    forms,
    ownerEmail: forms ? ownerEmail : undefined,
    steps,
    ...NEVER_ACTIVATE,
    safeguards: [
      'Require explicit account authorization before each provider mutation',
      'Never print, store, or commit Turnstile or API secrets',
      'Discover existing resources before create; fail on ownership/name collisions',
      'Do not report success until deployment and live acceptance pass',
      'No email provider or billing required by default',
      'A Turnstile widget without server-side Siteverify is not a working contact form',
      'D1/Workers form storage needs separate #89 cost and privacy approval before create'
    ]
  };
  let formsReview = null;
  if (forms) {
    formsReview = formsConsent === true
      ? formsReviewFor(planCore)
      : Object.freeze({
          status: 'blocked',
          reason: 'owner_form_consent_required',
          approvalDigest: null,
          freeLimits: TURNSTILE_FREE_LIMITS,
          ...NEVER_ACTIVATE
        });
  }
  return { ...planCore, formsReview };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  if (!process.argv[2]) throw Error('Usage: node pipeline/plan-customer.mjs customer.json');
  console.log(JSON.stringify(planCustomer(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
