import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainApprovalReview } from './domain-approval-review.mjs';
import { planCustomer } from './plan-customer.mjs';
import {
  consumeStoredToolkitApproval, ToolkitApprovalExecutionError
} from './approved-extension-consumer.mjs';

const account = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const owner = () => ({githubUserId: 42, githubLogin: 'siteowner', cloudflareAccountId: account});
const id = '12345678-1234-4234-8234-123456789abc';
const jobId = '87654321-4321-4321-8321-cba987654321';
const domainReview = (host = 'example.com') => buildDomainApprovalReview({
  cloudflareAccountId: account, githubUserId: 42, hostname: host, domainConsent: true
});
const emailReview = (host = 'example.com', mailbox = 'user@example.net') =>
  buildDomainApprovalReview({
    cloudflareAccountId: account, githubUserId: 42, hostname: host,
    domainConsent: true, mailbox
  });
const formsReview = () => planCustomer({
  name: 'Fern', accountId: account, githubOwner: 'siteowner',
  hostname: 'example.com', forms: true, formsConsent: true,
  ownerEmail: 'user@example.net'
}).formsReview;

function row(kind = 'domain', payload = {}, digest) {
  const plan = kind === 'domain' ? domainReview(payload.hostname || 'example.com') :
    kind === 'email' ? emailReview(payload.hostname || 'example.com', payload.mailbox || 'user@example.net') :
    formsReview();
  return {
    id, job_id: jobId, github_user_id: 42, cloudflare_account_id: account,
    status: 'approved', kind, approval_digest: digest === undefined ? plan.approvalDigest : digest,
    payload_json: JSON.stringify({
      hostname: 'example.com',
      ...(kind === 'email' ? {mailbox: 'user@example.net'} : {}),
      ...(kind === 'forms' ? {name: 'Fern', ownerEmail: 'user@example.net'} : {}),
      ...payload
    })
  };
}

const site = () => ({
  jobId, githubUserId: 42, githubLogin: 'siteowner',
  cloudflareAccountId: account, status: 'live', repositoryId: 77,
  repositoryName: 'esp-fern', pagesProjectId: 'pages_project_123',
  pagesProjectName: 'esp-fern-site', productionBranch: 'main'
});
const project = () => ({
  name: 'esp-fern-site', id: 'pages_project_123',
  subdomain: 'esp-fern-site.pages.dev',
  production_branch: 'main', uses_functions: false,
  source: {type: 'github', config: {
    owner: 'siteowner', owner_id: 42, repo_name: 'esp-fern', repo_id: 77,
    production_deployments_enabled: true
  }},
  build_config: {root_dir: '', destination_dir: 'public', build_command: null}
});
const repo = () => ({
  id: 77, name: 'esp-fern', private: true, default_branch: 'main',
  owner: {id: 42, login: 'siteowner'}
});
const gate = reviewRow => ({
  authorized: true, source: 'stored-cost-privacy-approval',
  approvalId: 'f2345678-1234-4234-8234-123456789abc',
  jobId, githubUserId: 42, cloudflareAccountId: account,
  pagesProjectId: 'pages_project_123',
  formsDigest: reviewRow.approval_digest,
  costApproved: true, privacyApproved: true, retentionDays: 30,
  maxSubmissionsPerDay: 50, maxBodyBytes: 4096
});

function rig(reviewRow = row(), overrides = {}) {
  const calls = [], state = {domain: null, rule: null, claimed: false, finished: false};
  const store = {
    async readApproved() {calls.push('store.read'); return reviewRow;},
    async readAppliedDomain() {
      calls.push('store.domain');
      return {...row('domain'), status: 'applied', id: 'abcdefab-cdef-4def-8def-abcdefabcdef'};
    },
    async claimApproved() {
      calls.push('store.claim');
      if (state.claimed) return false;
      state.claimed = true;
      return true;
    },
    async finish(_row, result) {calls.push('store.finish'); state.finished = result; return true;},
    async fail(_row, result) {calls.push('store.fail'); state.failed = result;}
  };
  const provider = {
    async readPagesProject() { calls.push('provider.project'); return project(); },
    async readGithubRepository() { calls.push('provider.repo'); return repo(); },
    async readPagesDomain() {calls.push('provider.domain'); return state.domain;},
    async attachPagesDomain(_site, input) {
      calls.push('provider.attach');
      state.domain = {name: input.name, status: 'pending'};
      return state.domain;
    },
    async readOwnedZone() {
      calls.push('provider.zone');
      return {id: zoneId, name: 'example.com', account: {id: account}, status: 'active'};
    },
    async readEmailRoutingSettings() {
      calls.push('provider.emailSettings'); return {enabled: true, status: 'ready'};
    },
    async readVerifiedDestination(_account, mailbox) {
      calls.push('provider.destination');
      return {email: mailbox, verified: '2026-11-22T12:00:00Z'};
    },
    async readEmailRoutingRule() {calls.push('provider.rule'); return state.rule;},
    async createEmailRoutingRule(_zone, spec) {
      calls.push('provider.createRule'); state.rule = {
        id: 'routing1', enabled: true, actions: spec.actions
      }; return state.rule;
    },
    async createTurnstileWidget() {
      calls.push('provider.turnstile'); return {sitekey: 'widgetkey', secret: 'not-in-response'};
    },
    async createCustomerD1() {
      calls.push('provider.d1'); return {id: 'd1-id'};
    },
    async deployServerVerifiedFormWorker() {
      calls.push('provider.worker'); return {id: 'worker-id'};
    },
    async verifyFormAcceptance() {
      calls.push('provider.acceptance');
      return {serverSiteverify: true, customerD1Bound: true, endToEndAccepted: true};
    }
  };
  const api = {
    approvalId: id,
    principal: owner(),
    approvalStore: store,
    siteStore: { async readLiveSite() { calls.push('site.read'); return site(); } },
    provider,
    assertCurrentAuthorization: async () => {calls.push('auth.check'); return true;},
    ...overrides
  };
  return {calls, state, store, provider, api};
}
async function rejected(r, code, {noProvider = false, noWrites = false} = {}) {
  await assert.rejects(consumeStoredToolkitApproval(r.api),
    error => error instanceof ToolkitApprovalExecutionError && error.code === code);
  if (noProvider) assert.equal(r.calls.some(s => s.startsWith('provider.')), false);
  if (noWrites) assert.deepEqual(r.calls.filter(s => [
    'provider.attach','provider.createRule', 'provider.turnstile',
    'provider.d1','provider.worker'
  ].includes(s)), []);
}

test('domain attaches the exact approved hostname; no DNS or MX operation exists', async () => {
  const r = rig();
  const result = await consumeStoredToolkitApproval(r.api);
  assert.deepEqual(r.calls.filter(s => s === 'provider.attach'), ['provider.attach']);
  assert.equal(result.hostname, 'example.com');
  assert.equal(result.projectId, 'pages_project_123');
  assert.equal(result.status, 'attached_pending_dns');
  assert.equal(result.dnsWritten, false);
  assert.equal(result.mxWritten, false);
  assert.equal(r.state.finished.status, 'attached_pending_dns');
});

test('bad digest fails before any provider call or claim', async () => {
  const r = rig(row('domain', {}, 'f'.repeat(64)));
  await rejected(r, 'approval_digest_mismatch', {noProvider: true});
  assert.equal(r.state.claimed, false);
});

test('another GitHub user or Cloudflare account cannot consume this row', async () => {
  for (const principal of [
    {...owner(), githubUserId: 43},
    {...owner(), cloudflareAccountId: 'c'.repeat(32)}
  ]) {
    const r = rig(row(), {principal});
    await rejected(r, 'owned_approved_row_required', {noProvider: true});
  }
});

test('another job, replaced Pages project, and changed GitHub repo fail closed', async () => {
  const r = rig();
  r.api.siteStore.readLiveSite = async () => ({...site(), pagesProjectId: 'wrong'});
  await rejected(r, 'provider_resource_mismatch', {noWrites: true});
  const q = rig();
  q.api.siteStore.readLiveSite = async () => ({...site(), jobId: 'wrong'});
  await rejected(q, 'current_owned_site_required', {noProvider: true});
  const p = rig();
  p.provider.readGithubRepository = async () => ({...repo(), id: 123});
  await rejected(p, 'provider_resource_mismatch', {noWrites: true});
});

test('an unapproved, stale, or already claimed row never writes providers', async () => {
  const a = rig({...row(), status: 'pending'});
  await rejected(a, 'owned_approved_row_required', {noProvider: true});
  const b = rig();
  b.store.claimApproved = async () => false;
  await rejected(b, 'approval_already_claimed_or_changed', {noWrites: true});
  const c = rig();
  c.api.assertCurrentAuthorization = async () => false;
  await rejected(c, 'authorization_changed', {noProvider: true});
});

test('email requires a separately applied matching domain row', async () => {
  const r = rig(row('email'));
  r.store.readAppliedDomain = async () => null;
  await rejected(r, 'applied_domain_row_required', {noWrites: true});
  assert.equal(r.calls.includes('provider.createRule'), false);
});

test('email refuses changed hostname or changed forwarding mailbox', async () => {
  for (const payload of [
    {hostname: 'other.example.com'},
    {mailbox: 'attacker@example.net'}
  ]) {
    const r = rig(row('email', payload));
    await rejected(r, 'approval_digest_mismatch', {noProvider: true});
  }
});

test('email requires an active Pages custom domain on correct project and verified destination', async () => {
  const r = rig(row('email'));
  await rejected(r, 'domain_not_active_on_owned_pages', {noWrites: true});
  const s = rig(row('email'));
  s.state.domain = {name: 'example.com', status: 'active'};
  s.provider.readVerifiedDestination = async () => ({email: 'user@example.net', verified: null});
  await rejected(s, 'verified_existing_destination_required', {noWrites: true});
});

test('email never enables routing or MX; creates only the fixed contact alias after prechecks', async () => {
  const r = rig(row('email'));
  r.state.domain = {name: 'example.com', status: 'active'};
  const out = await consumeStoredToolkitApproval(r.api);
  assert.equal(out.alias, 'contact@example.com');
  assert.equal(out.mailbox, 'user@example.net');
  assert.equal(out.sendingMailbox, false);
  assert.equal(out.mxWritten, false);
  assert.equal(r.calls.filter(s => s === 'provider.createRule').length, 1);
  assert.equal(r.calls.some(s => s === 'provider.attach'), false);
});

test('email fails closed on owner zone mismatch, unready DNS, and existing alias collision', async () => {
  for (let variant = 0; variant < 3; variant++) {
    const r = rig(row('email')); r.state.domain = {name: 'example.com', status: 'active'};
    if (variant === 0) r.provider.readOwnedZone = async () =>
      ({id: zoneId, name: 'example.com', account: {id: 'd'.repeat(32)}, status: 'active'});
    if (variant === 1) r.provider.readEmailRoutingSettings = async () =>
      ({enabled: false, status: 'unconfigured'});
    if (variant === 2) r.state.rule = {
      enabled: true, actions: [{type: 'forward', value: ['attacker@example.org']}]
    };
    await rejected(r, ['owned_zone_required','email_routing_dns_not_ready','existing_email_rule_conflict'][variant],
      {noWrites: true});
  }
});

test('forms without recorded consent, even if widget exists, fail before provider calls', async () => {
  const noConsent = planCustomer({
    name: 'Fern', accountId: account, githubOwner: 'siteowner',
    hostname: 'example.com', forms: true, formsConsent: false,
    ownerEmail: 'user@example.net'
  }).formsReview;
  const r = rig(row('forms', {}, noConsent.approvalDigest));
  await rejected(r, 'owned_approved_row_required', {noProvider: true});
});

test('forms have no activation from a review-only #89 plan or a mere boolean gate', async () => {
  const r = rig(row('forms'));
  delete r.api.verifyFormsCostPrivacyGate;
  await rejected(r, 'cost_privacy_gate_required', {noProvider: true});
  const s = rig(row('forms'), {
    verifyFormsCostPrivacyGate: async () => ({authorized: true})
  });
  await rejected(s, 'cost_privacy_gate_required', {noProvider: true});
});

test('forms must have independent exact #89 approved row and server-side Siteverify acceptance', async () => {
  const review = row('forms');
  const r = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review)});
  r.state.domain = {name: 'example.com', status: 'active'};
  const out = await consumeStoredToolkitApproval(r.api);
  assert.equal(out.workingForm, true);
  assert.equal(out.kind, 'forms');
  assert.deepEqual(r.calls.filter(s => ['provider.turnstile','provider.d1','provider.worker','provider.acceptance'].includes(s)),
    ['provider.turnstile','provider.d1','provider.worker','provider.acceptance']);
  assert.equal(JSON.stringify(out).includes('not-in-response'), false);
  const deniedForm = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review)});
  deniedForm.state.domain = {name: 'example.com', status: 'active'};
  deniedForm.provider.verifyFormAcceptance = async () => ({
    serverSiteverify: false, customerD1Bound: true, endToEndAccepted: true
  });
  await rejected(deniedForm, 'form_not_working_until_acceptance');
  assert.equal(deniedForm.state.finished, false);
  assert.equal(deniedForm.calls.includes('store.fail'), true);
});

test('forms reject approval gate with a different site or missing privacy approval', async () => {
  const review = row('forms');
  for (const bad of [
    {pagesProjectId: 'wrong'},
    {privacyApproved: false},
    {formsDigest: '0'.repeat(64)},
    {retentionDays: 400}
  ]) {
    const r = rig(review, {verifyFormsCostPrivacyGate: async () => ({...gate(review), ...bad})});
    await rejected(r, 'cost_privacy_gate_required', {noProvider: true});
  }
});
