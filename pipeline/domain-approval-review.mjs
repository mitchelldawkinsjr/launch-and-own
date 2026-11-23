// Issue #88: Domain approval package for custom domain, email routing, and redirects.
// Review-only. Never writes DNS, MX, SPF, DKIM, nameservers, or TLS.
import { createHash } from 'node:crypto';
import { TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])*)+$/i;
const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PATH = /^\/[a-z0-9._~/-]{0,200}$/i;

const NEVER = Object.freeze({
  dnsWriteAuthorized: false,
  mxWriteAuthorized: false,
  nameserverChangeAuthorized: false,
  canActivate: false,
  canWrite: false,
  createResources: false
});

function deny(reason, state = 'blocked_permission_or_plan') {
  if (!TOOLKIT_CAPABILITY_STATES.includes(state)) throw Error('unknown capability state');
  return Object.freeze({
    status: 'blocked',
    state,
    reason,
    approvalDigest: null,
    ...NEVER
  });
}

function hostnameOf(raw) {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  if (!HOST.test(host) || host.length > 253 || host.includes('*') || host.includes(':') || host.includes('/'))
    return null;
  if (/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return null;
  if (host.endsWith('.pages.dev')) return null;
  return host;
}

function sameHostRedirects(list, host) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 20) return null;
  const out = [];
  for (const rule of list) {
    if (!rule || rule.from === rule.to || !PATH.test(rule.from || '') || !PATH.test(rule.to || ''))
      return null;
    if (rule.to.includes('//') || rule.from.includes('//')) return null;
    out.push({ from: rule.from, to: rule.to, host, status: 301 });
  }
  return out;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Domain reviews this object before any DNS or mail change.
 * `domainConsent: true` only means the owner asked for a review, not that Domain approved a write.
 */
export function buildDomainApprovalReview({
  cloudflareAccountId, githubUserId, hostname, domainConsent, mailbox, redirects
} = {}) {
  if (typeof cloudflareAccountId !== 'string' || !ACCOUNT.test(cloudflareAccountId)
      || !Number.isSafeInteger(githubUserId) || githubUserId < 1)
    return deny('verified_owner_required', 'not_available');
  if (domainConsent !== true)
    return deny('domain_owner_consent_required', 'available_opt_in');
  const host = hostnameOf(hostname);
  if (!host) return deny('verified_custom_hostname_required');
  const rules = sameHostRedirects(redirects, host);
  if (!rules) return deny('redirects_must_stay_on_the_same_host');
  let emailState = 'not_available';
  let emailReason = 'verified_mailbox_required';
  if (mailbox !== undefined) {
    if (typeof mailbox !== 'string' || !MAILBOX.test(mailbox) || mailbox.toLowerCase().endsWith('@' + host))
      return deny('forward_to_an_existing_external_mailbox');
    emailState = 'manual_setup';
    emailReason = 'email_routing_guide_only_no_mx_write';
  }
  const plan = Object.freeze({
    kind: 'launch-and-own-domain-approval-review',
    version: 1,
    cloudflareAccountId: cloudflareAccountId.toLowerCase(),
    githubUserId,
    hostname: host,
    registrarIncluded: false,
    capabilities: Object.freeze({
      custom_domains: Object.freeze({
        state: 'manual_setup',
        reason: 'domain_purchase_and_dns_control_are_separate',
        tls: 'universal_ssl_covers_apex_and_one_label'
      }),
      email_routing: Object.freeze({ state: emailState, reason: emailReason, sendingMailbox: false }),
      redirects: Object.freeze({
        state: rules.length ? 'available_opt_in' : 'manual_setup',
        reason: rules.length ? 'same_host_path_redirects_await_domain_approval' : 'no_redirects_requested',
        rules: Object.freeze(rules)
      })
    }),
    notices: Object.freeze([
      'Buying a domain is not included.',
      'This review does not change DNS, MX, SPF, DKIM, or nameservers.',
      'Email Routing can forward to an existing mailbox. It is not a hosted sending mailbox.',
      'Inbound MX changes can disrupt existing email and need a separate Domain approval.'
    ]),
    ...NEVER
  });
  return Object.freeze({
    status: 'awaiting_domain_approval',
    state: 'manual_setup',
    reason: 'domain_must_approve_before_any_dns_or_mx_write',
    approvalDigest: createHash('sha256').update(stableJson(plan), 'utf8').digest('hex'),
    plan,
    ...NEVER
  });
}
