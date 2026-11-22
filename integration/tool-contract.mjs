/**
 * Contract-first guardrails for the future shared Launch & Own MCP/API bridge.
 *
 * NOT a server, OAuth verifier, token validator, or provider client.
 * A future host must authenticate/audience-check every request at the transport
 * boundary and supply a trusted principal + tenant-scoped persisted records.
 * These helpers intentionally perform zero I/O or resource mutations.
 */
export const CONTRACT_VERSION = 1;
export const BROWSER_ORIGIN = 'https://onboard.360web.cloud';
export const BRIDGE_AUDIENCE = 'launch-and-own-mcp';
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,79}$/;
const SAFE_STATES = new Set([
  'draft', 'queued', 'pending_deployment', 'needs_reauthorization',
  'failed', 'live'
]);
const MAX_TEXT = 2000;
const MAX_BRIEF = 12000;
const nullable = x => x === null || x === undefined;

export class BridgeContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BridgeContractError';
    this.code = code;
  }
}

const deny = code => { throw new BridgeContractError(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;
const own = (o, k) => Object.hasOwn(o, k);
const textIn = (value, min, max) => typeof value === 'string' &&
  value.length >= min && value.length <= max && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const simpleText = (value, max = MAX_TEXT) => textIn(value, 1, max);
const simpleId = value => typeof value === 'string' && ID.test(value);
const hexSha = value => typeof value === 'string' && SHA.test(value);
const hexDigest = value => typeof value === 'string' && DIGEST.test(value);

function exactKeys(value, allowed, required = allowed) {
  if (!object(value)) deny('invalid_arguments');
  if (Object.keys(value).some(k => !allowed.includes(k)) ||
      required.some(k => !own(value, k))) deny('invalid_arguments');
}

function validSiteSpec(spec) {
  exactKeys(spec, ['name', 'headline', 'about', 'services', 'contactEmail', 'theme'],
    ['name', 'headline', 'about', 'services']);
  if (!simpleText(spec.name, 120) || !simpleText(spec.headline, 180) ||
      !simpleText(spec.about, MAX_BRIEF) ||
      !Array.isArray(spec.services) || spec.services.length > 6 ||
      spec.services.some(s => !simpleText(s, 180))) deny('invalid_arguments');
  if (!nullable(spec.contactEmail) &&
      (!textIn(spec.contactEmail, 3, 254) ||
       !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(spec.contactEmail)))
    deny('invalid_arguments');
  if (!nullable(spec.theme) ||
      !['ocean', 'forest', 'sunset', 'graphite'].includes(spec.theme))
    deny('invalid_arguments');
  // Untrusted model input cannot include HTML/ZIP/blob URLs or provider IDs.
  return Object.freeze({
    name: spec.name, headline: spec.headline, about: spec.about,
    services: Object.freeze([...spec.services]),
    ...(spec.contactEmail ? {contactEmail: spec.contactEmail} : {}),
    ...(spec.theme ? {theme: spec.theme} : {})
  });
}

function validChanges(changes) {
  exactKeys(changes, ['headline', 'about', 'services', 'contactEmail'], []);
  if (!Object.keys(changes).length) deny('invalid_arguments');
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'services') {
      if (!Array.isArray(value) || value.length > 6 ||
          value.some(s => !simpleText(s, 180))) deny('invalid_arguments');
    } else if (key === 'contactEmail') {
      if (!nullable(value) && (!textIn(value, 3, 254) ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))
        deny('invalid_arguments');
    } else if (!simpleText(value, key === 'headline' ? 180 : MAX_BRIEF)) {
      deny('invalid_arguments');
    }
  }
  return Object.freeze({...changes, ...(own(changes, 'services') ?
    {services: Object.freeze([...changes.services])} : {})});
}

/**
 * These are proposed *model-facing operation names*, NOT available endpoints.
 * All write-like tool calls create drafts or request HUMAN browser handoff;
 * provider writes remain exclusively in the existing approved job runner.
 */
export const OPERATIONS = Object.freeze({
  get_connection_status: Object.freeze({linked: false, args: [], required: []}),
  start_connect_accounts: Object.freeze({linked: false, args: [], required: []}),
  list_sites: Object.freeze({linked: true, args: [], required: []}),
  get_site: Object.freeze({linked: true, args: ['site_id'], required: ['site_id']}),
  prepare_site: Object.freeze({linked: true, args: ['site_spec'], required: ['site_spec']}),
  prepare_site_update: Object.freeze({
    linked: true,
    args: ['site_id', 'base_commit_sha', 'changes'],
    required: ['site_id', 'base_commit_sha', 'changes']
  }),
  get_exact_preview: Object.freeze({
    linked: true, args: ['draft_id'], required: ['draft_id']
  }),
  request_explicit_approval: Object.freeze({
    linked: true,
    args: ['draft_id', 'preview_sha256', 'idempotency_key'],
    required: ['draft_id', 'preview_sha256', 'idempotency_key']
  }),
  get_job_status: Object.freeze({linked: true, args: ['job_id'], required: ['job_id']}),
  verify_publication: Object.freeze({linked: true, args: ['job_id'], required: ['job_id']})
});

export function assertTrustedPrincipal(principal, {nowSeconds} = {}) {
  // Must be supplied by trusted transport middleware AFTER validating token
  // signature, issuer, audience, expiry, scopes, and account-link challenge.
  // Never build this from model arguments or client-provided owner IDs.
  if (!object(principal) ||
      principal.authenticated !== true ||
      principal.audience !== BRIDGE_AUDIENCE ||
      !simpleId(principal.subject) ||
      !Number.isSafeInteger(principal.expiresAt) ||
      !Number.isSafeInteger(nowSeconds) ||
      principal.expiresAt <= nowSeconds)
    deny('unauthenticated');
  if (!nullable(principal.linkedOwner)) {
    const owner = principal.linkedOwner;
    if (!object(owner) ||
        !Number.isSafeInteger(owner.githubUserId) || owner.githubUserId <= 0 ||
        typeof owner.cloudflareAccountId !== 'string' ||
        !ACCOUNT_ID.test(owner.cloudflareAccountId) ||
        !Number.isSafeInteger(owner.authorizationEpoch) ||
        owner.authorizationEpoch < 0 ||
        owner.reauthorized !== true)
      deny('needs_reauthorization');
  }
  return Object.freeze({
    subject: principal.subject,
    ...(principal.linkedOwner ? {owner: Object.freeze({
      githubUserId: principal.linkedOwner.githubUserId,
      cloudflareAccountId: principal.linkedOwner.cloudflareAccountId.toLowerCase(),
      authorizationEpoch: principal.linkedOwner.authorizationEpoch
    })} : {})
  });
}

export function validateToolCall({name, arguments: args}, principal, opts = {}) {
  if (typeof name !== 'string' || !own(OPERATIONS, name)) deny('unknown_tool');
  const operation = OPERATIONS[name];
  const scope = assertTrustedPrincipal(principal, opts);
  if (operation.linked && !scope.owner) deny('needs_reauthorization');
  exactKeys(args, operation.args, operation.required);
  const normalized = {...args};
  for (const key of ['site_id', 'job_id', 'draft_id']) {
    if (own(normalized, key) && !simpleId(normalized[key])) deny('invalid_arguments');
  }
  if (own(normalized, 'base_commit_sha') && !hexSha(normalized.base_commit_sha))
    deny('invalid_arguments');
  if (own(normalized, 'preview_sha256') && !hexDigest(normalized.preview_sha256))
    deny('invalid_arguments');
  if (own(normalized, 'idempotency_key') &&
      (!simpleId(normalized.idempotency_key) ||
       normalized.idempotency_key.length < 16))
    deny('invalid_arguments');
  if (own(normalized, 'site_spec')) normalized.site_spec = validSiteSpec(normalized.site_spec);
  if (own(normalized, 'changes')) normalized.changes = validChanges(normalized.changes);
  return Object.freeze({name, arguments: Object.freeze(normalized), scope});
}

/**
 * Double fence after *tenant-scoped* database reads, not only at the API edge.
 * A guessed site/job/draft ID must never cross tenants, even if IDs collide.
 */
export function assertOwnedRecord(record, scope) {
  if (!object(scope) || !scope.owner ||
      !object(record) ||
      record.subject !== scope.subject ||
      record.githubUserId !== scope.owner.githubUserId ||
      String(record.cloudflareAccountId).toLowerCase() !== scope.owner.cloudflareAccountId ||
      record.authorizationEpoch !== scope.owner.authorizationEpoch)
    deny('not_found');
  return record;
}

/** Only a known, cookie-authenticated browser page may be handed to the client. */
export function assertSafeBrowserHandoff(url) {
  if (typeof url !== 'string') deny('unsafe_handoff');
  let parsed;
  try { parsed = new URL(url); } catch { deny('unsafe_handoff'); }
  if (parsed.origin !== BROWSER_ORIGIN || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !['/', '/review', '/history'].includes(parsed.pathname) ||
      url !== parsed.href)
    deny('unsafe_handoff');
  return url;
}

/**
 * A model may REQUEST approval, not approve anything. No approval boolean,
 * authorization token, signed receipt, OAuth state, or provider write response
 * appears in this result.
 */
export function humanApprovalHandoff({url, draftId, previewSha256, expiresAt}, scope, {nowSeconds}) {
  if (!scope?.owner || !simpleId(draftId) || !hexDigest(previewSha256) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds ||
      expiresAt > nowSeconds + 15 * 60)
    deny('invalid_approval_handoff');
  return Object.freeze({
    state: 'needs_human_approval',
    draft_id: draftId,
    preview_sha256: previewSha256.toLowerCase(),
    action: 'open_hosted_review',
    action_url: assertSafeBrowserHandoff(url)
  });
}

/**
 * Tool responses cannot claim "live" from a job state alone. The backend
 * verifier must have independently obtained canonical production commit and
 * public HTML digest, both bound to the exact immutable approved revision.
 * This function filters all unexpected fields (tokens, HTML, grants, etc.).
 */
export function publicationStatus(record, scope) {
  assertOwnedRecord(record, scope);
  if (!SAFE_STATES.has(record.status)) deny('invalid_publication_status');
  const basics = {job_id: record.id, state: record.status};
  if (!simpleId(record.id)) deny('invalid_publication_status');
  if (record.status !== 'live') return Object.freeze(basics);
  if (record.canonicalProductionVerified !== true ||
      record.publicHtmlVerified !== true ||
      !hexSha(record.productionCommitSha) ||
      !hexDigest(record.publicHtmlSha256) ||
      !hexDigest(record.approvedHtmlSha256) ||
      record.publicHtmlSha256.toLowerCase() !== record.approvedHtmlSha256.toLowerCase() ||
      record.verifiedCommitSha?.toLowerCase() !== record.productionCommitSha.toLowerCase())
    return Object.freeze({job_id: record.id, state: 'pending_deployment'});
  return Object.freeze({
    ...basics,
    production_commit_sha: record.productionCommitSha.toLowerCase(),
    public_html_sha256: record.publicHtmlSha256.toLowerCase()
  });
}
