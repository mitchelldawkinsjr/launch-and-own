// #88 / Agent 2 (GPT-6): consume, but never create, separately stored toolkit approvals.
// Wire a D1 adapter only after Agent 1 finalizes its additive migration contract.
// This module has no credentials, fetch, HTML, global side effects or customer secrets.
import { createHash } from 'node:crypto';
import { buildDomainApprovalReview } from './domain-approval-review.mjs';
import { planCustomer, TURNSTILE_FREE_LIMITS } from './plan-customer.mjs';
import { matchesApprovedPagesProject } from './approved-pages-project.mjs';
import { buildFormWorkerReview } from './forms-provider-plan.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPAQUE = /^[a-z0-9_-]{1,128}$/;
const ACTIONS = new Set(['domain', 'email', 'forms']);

export class ToolkitApprovalExecutionError extends Error {
  constructor(code) {
    super('Toolkit approval execution denied (' + code + ')');
    this.name = 'ToolkitApprovalExecutionError';
    this.code = code;
  }
}
const deny = code => { throw new ToolkitApprovalExecutionError(code); };
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const same = (a, b) => String(a) === String(b);
const lower = s => typeof s === 'string' ? s.toLowerCase() : '';
const mailbox = m => typeof m === 'string' && EMAIL.test(m) && m.length <= 90 && m === m.trim();
const noMethods = o => o && typeof o === 'object' && !Array.isArray(o);

function approvedRow(raw, requestedId, owner) {
  if (!noMethods(raw) || raw.id !== requestedId || !UUID.test(raw.id) ||
      !UUID.test(raw.job_id) || raw.github_user_id !== owner.githubUserId ||
      raw.cloudflare_account_id !== owner.cloudflareAccountId ||
      raw.status !== 'approved' || !ACTIONS.has(raw.kind) ||
      typeof raw.approval_digest !== 'string' || !DIGEST.test(raw.approval_digest) ||
      typeof raw.payload_json !== 'string' || raw.payload_json.length > 8192)
    deny('owned_approved_row_required');
  let payload;
  try { payload = JSON.parse(raw.payload_json); } catch { deny('invalid_review_payload'); }
  if (!noMethods(payload)) deny('invalid_review_payload');
  return Object.freeze({
    id: raw.id, jobId: raw.job_id, kind: raw.kind, githubUserId: raw.github_user_id,
    cloudflareAccountId: raw.cloudflare_account_id, digest: lower(raw.approval_digest),
    payload: Object.freeze(payload), payloadJson: raw.payload_json
  });
}

function ownerSnapshot(principal) {
  if (!positiveId(principal?.githubUserId) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(principal?.githubLogin || '') ||
      !ACCOUNT.test(principal?.cloudflareAccountId || ''))
    deny('current_owner_required');
  return Object.freeze({
    githubUserId: principal.githubUserId,
    githubLogin: principal.githubLogin,
    cloudflareAccountId: lower(principal.cloudflareAccountId)
  });
}

function checkedSite(raw, row, owner) {
  if (!noMethods(raw) || raw.jobId !== row.jobId ||
      raw.githubUserId !== owner.githubUserId ||
      lower(raw.githubLogin) !== lower(owner.githubLogin) ||
      raw.cloudflareAccountId !== owner.cloudflareAccountId ||
      raw.status !== 'live' || !positiveId(raw.repositoryId) ||
      !OPAQUE.test(raw.pagesProjectId || '') ||
      !/^(esp-[a-z0-9]+(?:-[a-z0-9]+)*)-site$/.test(raw.pagesProjectName || '') ||
      raw.repositoryName + '-site' !== raw.pagesProjectName ||
      raw.productionBranch !== 'main' ||
      (raw.expectedCommitSha !== undefined && !COMMIT.test(raw.expectedCommitSha)))
    deny('current_owned_site_required');
  return Object.freeze({
    jobId: raw.jobId, githubUserId: raw.githubUserId,
    githubLogin: raw.githubLogin, cloudflareAccountId: raw.cloudflareAccountId,
    repositoryId: raw.repositoryId, repositoryName: raw.repositoryName,
    pagesProjectId: raw.pagesProjectId, pagesProjectName: raw.pagesProjectName,
    productionBranch: 'main', expectedCommitSha: raw.expectedCommitSha
  });
}

function checkedHostname(raw, {allowPagesDev = false} = {}) {
  if (typeof raw !== 'string' || raw !== raw.trim()) deny('hostname_required');
  const value = lower(raw);
  if (!HOST.test(value) || value.length > 253 || (!allowPagesDev && value.endsWith('.pages.dev')) ||
      /\.(?:localhost|local|internal|invalid|test)$/.test(value))
    deny('hostname_required');
  return value;
}

/**
 * Canonical email-only review. The existing domain planner does NOT hash the
 * forwarding mailbox, so its digest cannot authorize an Email Routing rule.
 * Agent 1 must use this distinct email digest for the persisted email row.
 */
export function buildEmailRoutingApprovalReview({
  githubUserId, cloudflareAccountId, hostname, mailbox: destination
} = {}) {
  const hostnameValue = checkedHostname(hostname);
  if (!positiveId(githubUserId) || !ACCOUNT.test(cloudflareAccountId || '') ||
      !mailbox(destination) || lower(destination).endsWith('@' + hostnameValue))
    deny('email_review_invalid');
  const domain = buildDomainApprovalReview({
    githubUserId, cloudflareAccountId, hostname: hostnameValue,
    domainConsent: true, mailbox: destination
  });
  if (domain.status !== 'awaiting_domain_approval')
    deny('email_review_invalid');
  const plan = Object.freeze({
    kind: 'launch-and-own-email-routing-approval', version: 1,
    githubUserId, cloudflareAccountId: lower(cloudflareAccountId),
    hostname: hostnameValue, mailbox: destination, alias: 'contact@' + hostnameValue,
    domainReviewDigest: domain.approvalDigest,
    sendingMailbox: false, dnsWriteAuthorized: false, mxWriteAuthorized: false
  });
  return Object.freeze({
    status: 'awaiting_email_approval',
    plan, approvalDigest: createHash('sha256')
      .update(JSON.stringify(plan), 'utf8').digest('hex'),
    canActivate: false, canWrite: false, mxWriteAuthorized: false
  });
}

function reviewedDomain(row, owner, {withMailbox = false} = {}) {
  const host = checkedHostname(row.payload.hostname);
  const dest = withMailbox ? row.payload.mailbox : undefined;
  if (withMailbox && (!mailbox(dest) || lower(dest).endsWith('@' + host)))
    deny('external_mailbox_required');
  // Digests are recomputed by the canonical existing planner, not trusted from D1.
  const review = buildDomainApprovalReview({
    githubUserId: owner.githubUserId,
    cloudflareAccountId: owner.cloudflareAccountId,
    hostname: host, domainConsent: true,
    ...(withMailbox ? {mailbox: dest} : {})
  });
  const actualDigest = withMailbox ? buildEmailRoutingApprovalReview({
    githubUserId: owner.githubUserId,
    cloudflareAccountId: owner.cloudflareAccountId,
    hostname: host, mailbox: dest
  }).approvalDigest : review.approvalDigest;
  if (review.status !== 'awaiting_domain_approval' || actualDigest !== row.digest)
    deny('approval_digest_mismatch');
  if (withMailbox && (review.plan.capabilities.email_routing.sendingMailbox !== false ||
      review.plan.capabilities.email_routing.state !== 'manual_setup'))
    deny('email_review_invalid');
  return {hostname: host, mailbox: dest};
}

function reviewedForms(row, site, owner) {
  const host = checkedHostname(row.payload.hostname, {allowPagesDev: true});
  if (host.endsWith('.pages.dev') && host !== site.pagesProjectName + '.pages.dev')
    deny('forms_site_mismatch');
  if (!mailbox(row.payload.ownerEmail) || typeof row.payload.name !== 'string' ||
      !row.payload.name.trim() || row.payload.name.length > 100)
    deny('forms_consent_payload_invalid');
  let review;
  try {
    review = planCustomer({
      name: row.payload.name, accountId: owner.cloudflareAccountId,
      githubOwner: owner.githubLogin, hostname: host,
      forms: true, formsConsent: true, ownerEmail: row.payload.ownerEmail
    }).formsReview;
  } catch { deny('forms_consent_payload_invalid'); }
  if (review?.kind !== 'launch-and-own-forms-review' ||
      review.approvalDigest !== row.digest || review.workingForm !== false ||
      review.siteverify.required !== true ||
      review.siteverify.url !== TURNSTILE_FREE_LIMITS.siteverifyUrl)
    deny('approval_digest_mismatch');
  if (row.payload.pagesProjectId && row.payload.pagesProjectId !== site.pagesProjectId)
    deny('forms_site_mismatch');
  return host;
}

async function authorized(assertCurrentAuthorization, principal, owner, site) {
  if (principal.githubUserId !== owner.githubUserId ||
      principal.githubLogin !== owner.githubLogin ||
      lower(principal.cloudflareAccountId) !== owner.cloudflareAccountId)
    deny('authorization_changed');
  if (typeof assertCurrentAuthorization !== 'function') deny('authorization_fence_required');
  let ok = false;
  try { ok = await assertCurrentAuthorization({owner, site}); } catch {}
  if (ok !== true || principal.githubUserId !== owner.githubUserId ||
      principal.githubLogin !== owner.githubLogin ||
      lower(principal.cloudflareAccountId) !== owner.cloudflareAccountId)
    deny('authorization_changed');
}

async function guarded(fence, call) {
  await fence();
  const result = await call();
  await fence();
  return result;
}

async function livePagesAndRepo(provider, site, fence) {
  if (typeof provider?.readPagesProject !== 'function' ||
      typeof provider?.readGithubRepository !== 'function')
    deny('provider_read_fence_required');
  const project = await guarded(fence, () => provider.readPagesProject(site));
  const repo = await guarded(fence, () => provider.readGithubRepository(site));
  // A current DB job revision is necessary but not sufficient: a site can be
  // edited directly in GitHub between consent and provider execution.
  if (site.expectedCommitSha) {
    if (typeof provider.readGithubBranchHead !== 'function')
      deny('provider_source_sha_fence_required');
    const branch = await guarded(fence, () => provider.readGithubBranchHead(site));
    if (branch?.commit?.sha !== site.expectedCommitSha)
      deny('provider_source_sha_changed');
  }
  if (repo?.id !== site.repositoryId || repo?.private !== true ||
      repo?.owner?.id !== site.githubUserId ||
      lower(repo?.owner?.login) !== lower(site.githubLogin) ||
      repo?.name !== site.repositoryName || repo?.default_branch !== 'main' ||
      !matchesApprovedPagesProject(project, {
        name: site.pagesProjectName, projectId: site.pagesProjectId,
        owner: site.githubLogin, ownerId: site.githubUserId,
        repositoryName: site.repositoryName, repositoryId: site.repositoryId,
        branch: 'main'
      }))
    deny('provider_resource_mismatch');
}

function verifiedPagesDomain(domain, host) {
  return domain?.name === host && domain?.status === 'active';
}

function sameZone(zone, host, accountId) {
  return zone && ACCOUNT.test(zone.id || '') &&
    zone.account?.id === accountId && zone.status === 'active' &&
    typeof zone.name === 'string' &&
    (host === zone.name || host.endsWith('.' + zone.name)) &&
    !zone.name.endsWith('.pages.dev');
}

function exactHostnameMxReady(records, hostname) {
  // Cloudflare Email Routing requires three MX records at the EXACT
  // receiving address hostname. A zone-apex "ready" status proves nothing
  // about a subdomain, and MX records on other hostnames cannot be reused.
  const required = new Set([
    'route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net'
  ]);
  if (!Array.isArray(records) || records.length !== required.size) return false;
  for (const record of records) {
    if (record?.type !== 'MX' || lower(record.name) !== hostname ||
        !Number.isSafeInteger(record.priority) || record.priority < 0 ||
        record.priority > 65535 || typeof record.content !== 'string') return false;
    const target = lower(record.content).replace(/\.$/, '');
    if (!required.delete(target)) return false;
  }
  return required.size === 0;
}

function validGate(gate, row, site) {
  // A read-only #89 review, digest by itself, checkbox, or client flag is NEVER an approval.
  // Future verifier must load a separately approved, account/job/revision-bound D1 row.
  return noMethods(gate) && gate.authorized === true && gate.source === 'stored-cost-privacy-approval' &&
    UUID.test(gate.approvalId || '') && gate.jobId === row.jobId &&
    gate.githubUserId === row.githubUserId &&
    gate.cloudflareAccountId === row.cloudflareAccountId &&
    gate.formsDigest === row.digest && gate.pagesProjectId === site.pagesProjectId &&
    gate.costApproved === true && gate.privacyApproved === true &&
    Number.isSafeInteger(gate.retentionDays) && gate.retentionDays > 0 &&
    gate.retentionDays <= 365 && Number.isSafeInteger(gate.maxSubmissionsPerDay) &&
    gate.maxSubmissionsPerDay > 0 && gate.maxSubmissionsPerDay <= 1000 &&
    Number.isSafeInteger(gate.maxBodyBytes) && gate.maxBodyBytes >= 256 &&
    gate.maxBodyBytes <= 65536;
}

async function domainWork({provider, site, row, owner, fence}) {
  const {hostname} = reviewedDomain(row, owner);
  const existing = await guarded(fence, () => provider.readPagesDomain(site, hostname));
  if (existing && existing.name !== hostname) deny('pages_domain_conflict');
  if (!existing) {
    if (typeof provider.attachPagesDomain !== 'function') deny('domain_permission_required');
    const attached = await guarded(fence, () => provider.attachPagesDomain(site, {name: hostname}));
    if (attached?.name !== hostname) deny('pages_attach_unverified');
  }
  const verified = await guarded(fence, () => provider.readPagesDomain(site, hostname));
  if (!verified || verified.name !== hostname ||
      !['active', 'pending', 'initializing'].includes(verified.status))
    deny('pages_attach_unverified');
  return {
    kind: 'domain', hostname, projectId: site.pagesProjectId,
    status: verified.status === 'active' ? 'attached_active' : 'attached_pending_dns',
    dnsWritten: false, mxWritten: false
  };
}

async function emailWork({provider, approvalStore, site, row, owner, fence}) {
  const {hostname, mailbox: dest} = reviewedDomain(row, owner, {withMailbox: true});
  if (typeof approvalStore.readAppliedDomain !== 'function')
    deny('applied_domain_row_required');
  const applied = await guarded(fence, () => approvalStore.readAppliedDomain({
    jobId: row.jobId, githubUserId: owner.githubUserId,
    cloudflareAccountId: owner.cloudflareAccountId, hostname
  }));
  if (applied?.status !== 'applied' || applied.kind !== 'domain' ||
      applied.job_id !== row.jobId ||
      applied.github_user_id !== owner.githubUserId ||
      applied.cloudflare_account_id !== owner.cloudflareAccountId ||
      !UUID.test(applied.id || '') || !DIGEST.test(applied.approval_digest || ''))
    deny('applied_domain_row_required');
  let domainPayload;
  try { domainPayload = JSON.parse(applied.payload_json || '{}'); }
  catch { deny('applied_domain_row_required'); }
  const approvedHost = reviewedDomain({
    digest: lower(applied.approval_digest), payload: domainPayload
  }, owner).hostname;
  if (approvedHost !== hostname) deny('matching_applied_domain_required');
  const onProject = await guarded(fence, () => provider.readPagesDomain(site, hostname));
  if (!verifiedPagesDomain(onProject, hostname))
    deny('domain_not_active_on_owned_pages');
  if (typeof provider.readOwnedZone !== 'function' ||
      typeof provider.readEmailRoutingSettings !== 'function' ||
      typeof provider.readRoutingMxRecords !== 'function' ||
      typeof provider.readVerifiedDestination !== 'function' ||
      typeof provider.readEmailRoutingRule !== 'function' ||
      typeof provider.createEmailRoutingRule !== 'function')
    deny('email_permissions_required');
  const zone = await guarded(fence, () => provider.readOwnedZone(site, hostname));
  if (!sameZone(zone, hostname, owner.cloudflareAccountId))
    deny('owned_zone_required');
  const settings = await guarded(fence, () => provider.readEmailRoutingSettings(zone.id));
  if (settings?.enabled !== true || settings?.status !== 'ready')
    deny('email_routing_dns_not_ready');
  // Subdomain mail is explicitly enabled separately by Cloudflare. Read
  // exact-host DNS for a complete three-target MX set; never "enable"
  // routing or mutate the user's existing business mail configuration.
  const mx = await guarded(fence, () => provider.readRoutingMxRecords(zone.id, hostname));
  if (!exactHostnameMxReady(mx, hostname))
    deny('email_hostname_mx_not_ready');
  const destination = await guarded(fence, () => provider.readVerifiedDestination(owner.cloudflareAccountId, dest));
  if (lower(destination?.email) !== lower(dest) ||
      typeof destination?.verified !== 'string' ||
      !Number.isFinite(Date.parse(destination.verified)))
    deny('verified_existing_destination_required');
  // Deliberately fixed alias: the existing domain review digest does not include arbitrary local-parts.
  const alias = 'contact@' + hostname;
  const rule = await guarded(fence, () => provider.readEmailRoutingRule(zone.id, alias));
  if (rule && (!rule.enabled ||
      !Array.isArray(rule.matchers) || rule.matchers.length !== 1 ||
      rule.matchers[0].type !== 'literal' || rule.matchers[0].field !== 'to' ||
      lower(rule.matchers[0].value) !== alias ||
      !Array.isArray(rule.actions) || rule.actions.length !== 1 ||
      rule.actions[0].type !== 'forward' ||
      !Array.isArray(rule.actions[0].value) || rule.actions[0].value.length !== 1 ||
      lower(rule.actions[0].value[0]) !== lower(dest)))
    deny('existing_email_rule_conflict');
  let createdId = null;
  if (!rule) {
    const added = await guarded(fence, () => provider.createEmailRoutingRule(zone.id, {
      name: 'Launch & Own contact forwarding for ' + hostname,
      enabled: true, source: 'api',
      matchers: [{type: 'literal', field: 'to', value: alias}],
      actions: [{type: 'forward', value: [dest]}]
    }));
    if (!added?.id || added.enabled !== true)
      deny('email_rule_unverified');
    createdId = added.id;
  }
  const verified = await guarded(fence, () => provider.readEmailRoutingRule(zone.id, alias));
  if (!verified?.id || (createdId !== null && verified.id !== createdId) ||
      verified.enabled !== true || verified.zone?.tag !== zone.id ||
      !Array.isArray(verified.matchers) || verified.matchers.length !== 1 ||
      verified.matchers[0]?.type !== 'literal' || verified.matchers[0]?.field !== 'to' ||
      lower(verified.matchers[0]?.value) !== alias ||
      !Array.isArray(verified.actions) || verified.actions.length !== 1 ||
      verified.actions[0]?.type !== 'forward' ||
      !Array.isArray(verified.actions[0]?.value) || verified.actions[0].value.length !== 1 ||
      lower(verified.actions[0].value[0]) !== lower(dest))
    deny('email_rule_unverified');
  return {
    kind: 'email', hostname, alias, mailbox: dest,
    zoneId: zone.id, status: 'routing_rule_recorded',
    sendingMailbox: false, dnsWritten: false, mxWritten: false
  };
}

const FORMS_STEPS = ['createTurnstileWidget', 'createCustomerD1', 'applyCustomerSchema'];

async function formsWork({provider, site, row, owner, verifyFormsCostPrivacyGate, fence, preflightGate,
  formsReceipts}) {
  const hostname = reviewedForms(row, site, owner);
  if (typeof verifyFormsCostPrivacyGate !== 'function')
    deny('cost_privacy_gate_required');
  const gate = await guarded(fence, () => verifyFormsCostPrivacyGate({
    jobId: row.jobId, owner, site, formsDigest: row.digest
  }));
  if (!validGate(gate, row, site) ||
      gate.approvalId !== preflightGate?.approvalId ||
      gate.retentionDays !== preflightGate.retentionDays ||
      gate.maxSubmissionsPerDay !== preflightGate.maxSubmissionsPerDay ||
      gate.maxBodyBytes !== preflightGate.maxBodyBytes)
    deny('cost_privacy_gate_changed');
  // Each completed provider step is recorded before the next one, so a failed run
  // resumes from its receipts. Never return or log secrets.
  let receipt = await guarded(fence, () => formsReceipts.read());
  if (receipt && receipt.gateApprovalId !== gate.approvalId) deny('forms_gate_changed_reconcile');
  const save = async fields => {
    receipt = await guarded(fence, () => formsReceipts.record({gateApprovalId: gate.approvalId, ...fields}));
    if (!receipt) deny('forms_receipt_not_saved');
  };
  if (!receipt) await save({});
  if (!receipt.widgetSitekey) {
    const widget = await guarded(fence, () => provider.createTurnstileWidget(site, {hostname}));
    if (!widget?.sitekey) deny('turnstile_widget_unverified');
    await save({widgetSitekey: widget.sitekey});
  }
  if (!receipt.databaseId) {
    const database = await guarded(fence, () => provider.createCustomerD1(site, {hostname}));
    if (!database?.id) deny('customer_d1_required');
    await save({databaseId: database.id});
  }
  if (!receipt.schemaApplied) {
    await guarded(fence, () => provider.applyCustomerSchema(site, {hostname, databaseId: receipt.databaseId}));
    await save({schemaApplied: true});
  }
  const workerReview = await guarded(fence, () => buildFormWorkerReview({
    pagesProjectName: site.pagesProjectName, hostname, databaseId: receipt.databaseId,
    gateApprovalId: gate.approvalId, maxBodyBytes: gate.maxBodyBytes,
    maxSubmissionsPerDay: gate.maxSubmissionsPerDay, retentionDays: gate.retentionDays
  }));
  if (!receipt.workerDeployed) {
    // The rotated secret goes straight into the upload and is never saved or returned.
    const secret = await guarded(fence, () => provider.rotateTurnstileSecret(site, {hostname, sitekey: receipt.widgetSitekey}));
    await guarded(fence, () => provider.uploadFormWorker(site, {hostname, databaseId: receipt.databaseId, gate, secret}));
    await save({workerDeployed: true});
  }
  if (!receipt.workerSubdomainEnabled) {
    const subdomain = await guarded(fence, () => provider.readWorkersSubdomain());
    await guarded(fence, () => provider.enableFormWorkerSubdomain(site, {hostname}));
    await save({workerSubdomainEnabled: true, workerUrl: 'https://' + workerReview.scriptName + '.' + subdomain + '.workers.dev'});
  }
  if (!receipt.workerScheduleSet) {
    await guarded(fence, () => provider.setFormWorkerSchedule(site, {hostname}));
    await save({workerScheduleSet: true});
  }
  // The Worker is live; the site's own form starts using it once the owner merges the connect pull request.
  return {
    kind: 'forms', jobId: row.jobId, hostname, status: 'form_worker_deployed', workingForm: false,
    sitekey: receipt.widgetSitekey, customerDatabaseId: receipt.databaseId,
    gateApprovalId: gate.approvalId, workerUrl: receipt.workerUrl, workerReview
  };
}

/**
 * Consumes exactly one approved D1 record using an injected transactional store.
 *
 * Store implementation MUST do an owner/account/job/digest/payload/status-fenced
 * SELECT and atomic compare-and-swap claim approved -> applying (single winner).
 * finish must CAS applying -> applied; fail must mark manual retry/reconciliation,
 * not queue indefinite unattended writes. These three methods MUST never accept
 * a request/browser-provided row or consent object as authority.
 *
 * Site store MUST independently read a live, current, owned launch job, not accept
 * client JSON or merely a 30-day toolkit card.
 */
export async function consumeStoredToolkitApproval({
  approvalId, principal, approvalStore, siteStore, provider,
  assertCurrentAuthorization, verifyFormsCostPrivacyGate, formsReceipts
} = {}) {
  const owner = ownerSnapshot(principal);
  if (!UUID.test(approvalId || '') ||
      typeof approvalStore?.readApproved !== 'function' ||
      typeof approvalStore?.claimApproved !== 'function' ||
      typeof approvalStore?.finish !== 'function' ||
      typeof siteStore?.readLiveSite !== 'function')
    deny('trusted_store_required');
  const fence = async site => authorized(assertCurrentAuthorization, principal, owner, site);
  await fence();
  const raw = await approvalStore.readApproved({
    id: approvalId, githubUserId: owner.githubUserId,
    cloudflareAccountId: owner.cloudflareAccountId
  });
  const row = approvedRow(raw, approvalId, owner);
  const site = checkedSite(await siteStore.readLiveSite({
    jobId: row.jobId, githubUserId: owner.githubUserId,
    cloudflareAccountId: owner.cloudflareAccountId
  }), row, owner);
  await fence(site);
  // Recompute exact approval BEFORE any claim or provider call.
  if (row.kind === 'domain') reviewedDomain(row, owner);
  if (row.kind === 'email') reviewedDomain(row, owner, {withMailbox: true});
  if (row.kind === 'forms') {
    const hostname = reviewedForms(row, site, owner);
    if (hostname !== site.pagesProjectName + '.pages.dev') deny('forms_hostname_not_active');
    if (FORMS_STEPS.some(step => typeof provider?.[step] !== 'function'))
      deny('forms_provider_permissions_required');
    if (typeof formsReceipts?.read !== 'function' || typeof formsReceipts.record !== 'function')
      deny('forms_receipts_required');
  }
  // Independent cost/privacy store gate; forms can never claim resources with
  // the current review-only #89 plan alone.
  let preflightGate = null;
  if (row.kind === 'forms') {
    if (typeof verifyFormsCostPrivacyGate !== 'function')
      deny('cost_privacy_gate_required');
    const gate = await guarded(() => fence(site), () => verifyFormsCostPrivacyGate({
      jobId: row.jobId, owner, site, formsDigest: row.digest
    }));
    if (!validGate(gate, row, site)) deny('cost_privacy_gate_required');
    preflightGate = gate;
  }
  await fence(site);
  await livePagesAndRepo(provider, site, () => fence(site));
  await fence(site);
  if (await approvalStore.claimApproved(row) !== true)
    deny('approval_already_claimed_or_changed');
  try {
    await fence(site);
    const work = {provider, approvalStore, site, row, owner, verifyFormsCostPrivacyGate,
      preflightGate, formsReceipts, fence: () => fence(site)};
    const result = row.kind === 'domain' ? await domainWork(work) :
      row.kind === 'email' ? await emailWork(work) : await formsWork(work);
    await fence(site);
    if (await approvalStore.finish(row, result) !== true)
      deny('execution_receipt_not_saved');
    return Object.freeze(result);
  } catch (error) {
    // No automatic retry: an external API may have succeeded before its receipt
    // failed. Reconcile the exact provider resource before any new customer action.
    if (typeof approvalStore.fail === 'function') {
      try { await approvalStore.fail(row, {reason: error?.code || 'provider_write_unconfirmed'}); }
      catch {}
    }
    throw error;
  }
}
