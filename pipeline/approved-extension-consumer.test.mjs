import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainApprovalReview } from './domain-approval-review.mjs';
import { planCustomer } from './plan-customer.mjs';
import {
  consumeStoredToolkitApproval, ToolkitApprovalExecutionError,
  buildEmailRoutingApprovalReview
} from './approved-extension-consumer.mjs';

const account = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const routingMx = hostname => [1,2,3].map((n,i) => ({
  type:'MX', name:hostname, content:'route'+n+'.mx.cloudflare.net', priority:10+i*10
}));
const owner = () => ({githubUserId: 42, githubLogin: 'siteowner', cloudflareAccountId: account});
const id = '12345678-1234-4234-8234-123456789abc';
const jobId = '87654321-4321-4321-8321-cba987654321';
const domainReview = (host = 'example.com') => buildDomainApprovalReview({
  cloudflareAccountId: account, githubUserId: 42, hostname: host, domainConsent: true
});
const emailReview = (host = 'example.com', mailbox = 'user@example.net') =>
  buildEmailRoutingApprovalReview({
    cloudflareAccountId: account, githubUserId: 42, hostname: host,
    domainConsent: true, mailbox
  });
const formsHost = 'esp-fern-site.pages.dev';
const formsDatabaseId = '11111111-2222-3333-4444-555555555555';
const formsReview = (hostname = formsHost) => planCustomer({
  name: 'Fern', accountId: account, githubOwner: 'siteowner',
  hostname, forms: true, formsConsent: true,
  ownerEmail: 'user@example.net'
}).formsReview;

function row(kind = 'domain', payload = {}, digest) {
  const plan = kind === 'domain' ? domainReview(payload.hostname || 'example.com') :
    kind === 'email' ? emailReview(payload.hostname || 'example.com', payload.mailbox || 'user@example.net') :
    formsReview(payload.hostname);
  return {
    id, job_id: jobId, github_user_id: 42, cloudflare_account_id: account,
    status: 'approved', kind, approval_digest: digest === undefined ? plan.approvalDigest : digest,
    payload_json: JSON.stringify({
      hostname: kind === 'forms' ? formsHost : 'example.com',
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
    async readRoutingMxRecords(_zone, hostname) {
      calls.push('provider.mxRead'); return routingMx(hostname);
    },
    async readVerifiedDestination(_account, mailbox) {
      calls.push('provider.destination');
      return {email: mailbox, verified: '2026-11-22T12:00:00Z'};
    },
    async readEmailRoutingRule() {calls.push('provider.rule'); return state.rule;},
    async createEmailRoutingRule(_zone, spec) {
      calls.push('provider.createRule'); state.rule = {
        id: 'routing1', enabled: true, actions: spec.actions,
        matchers:spec.matchers, zone:{tag:zoneId}
      }; return state.rule;
    },
    async createTurnstileWidget() {
      calls.push('provider.turnstile'); return {sitekey: 'widgetkey', secret: 'not-in-response'};
    },
    async createCustomerD1() {
      calls.push('provider.d1'); return {id: formsDatabaseId};
    },
    async applyCustomerSchema() { calls.push('provider.schema'); return {}; }
  };
  state.receipt = null;
  const formsReceipts = {
    async read() { calls.push('receipt.read'); return state.receipt; },
    async record({gateApprovalId, ...fields}) {
      calls.push('receipt.record');
      if (state.receipt && state.receipt.gateApprovalId !== gateApprovalId) return null;
      state.receipt = {gateApprovalId, widgetSitekey: null, databaseId: null, schemaApplied: false,
        ...state.receipt, ...fields};
      return state.receipt;
    }
  };
  const api = {
    approvalId: id,
    principal: owner(),
    approvalStore: store,
    siteStore: { async readLiveSite() { calls.push('site.read'); return site(); } },
    provider, formsReceipts,
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
    'provider.d1','provider.schema','provider.worker','provider.publish'
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

test('separate email digest binds the exact forwarding mailbox unlike domain-only plan', () => {
  assert.notEqual(emailReview('example.com', 'a@example.net').approvalDigest,
    emailReview('example.com', 'b@example.net').approvalDigest);
  assert.notEqual(emailReview('example.com', 'a@example.net').approvalDigest,
    emailReview('sub.example.com', 'a@example.net').approvalDigest);
  assert.equal(emailReview('example.com', 'a@example.net').plan.alias, 'contact@example.com');
});

test('email refuses changed hostname or changed forwarding mailbox', async () => {
  for (const payload of [
    {hostname: 'other.example.com'},
    {mailbox: 'attacker@example.net'}
  ]) {
    const original = row('email');
    // Attacker alters persisted payload while retaining the owner's original digest.
    const r = rig({...original, payload_json: JSON.stringify({
      hostname: 'example.com', mailbox: 'user@example.net', ...payload
    })});
    await rejected(r, 'approval_digest_mismatch', {noProvider: true});
  }
});

test('email refuses applied domain rows for a different host or kind', async () => {
  for (const mode of ['host', 'kind']) {
    const r = rig(row('email'));
    r.store.readAppliedDomain = async () => mode === 'kind'
      ? {...row('domain'), status: 'applied', kind: 'email'}
      : {...row('domain', {hostname: 'different.example.org'}), status: 'applied'};
    await rejected(r, mode === 'kind' ? 'applied_domain_row_required' :
      'matching_applied_domain_required', {noWrites: true});
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
  for (let variant = 0; variant < 4; variant++) {
    const r = rig(row('email')); r.state.domain = {name: 'example.com', status: 'active'};
    if (variant === 0) r.provider.readOwnedZone = async () =>
      ({id: zoneId, name: 'example.com', account: {id: 'd'.repeat(32)}, status: 'active'});
    if (variant === 1) r.provider.readEmailRoutingSettings = async () =>
      ({enabled: false, status: 'unconfigured'});
    if (variant === 2) r.state.rule = {
      id:'existing', enabled: true, zone:{tag:zoneId},
      matchers:[{type:'literal',field:'to',value:'contact@example.com'}],
      actions: [{type: 'forward', value: ['attacker@example.org']}]
    };
    if (variant === 3) r.state.rule = {
      id:'existing', enabled: true, zone:{tag:zoneId},
      actions: [{type: 'forward', value: ['user@example.net']}],
      matchers: [{type: 'literal', field: 'to', value: 'different@example.com'}]
    };
    await rejected(r, ['owned_zone_required','email_routing_dns_not_ready','existing_email_rule_conflict','existing_email_rule_conflict'][variant],
      {noWrites: true});
  }
});

test('email never creates routing alias without exact Cloudflare MX records on its hostname', async () => {
  for (const bad of [
    [],
    routingMx('example.com').slice(0,2),
    [...routingMx('example.com').slice(0,2),{type:'MX',name:'example.com',content:'mx.google.com',priority:30}],
    routingMx('www.example.com'),
    routingMx('example.com').map(r=>({...r,type:'TXT'})),
    routingMx('example.com').map(r=>({...r,content:'route1.mx.cloudflare.net'})),
    routingMx('example.com').map(r=>({...r,priority:null}))
  ]) {
    const r=rig(row('email')); r.state.domain={name:'example.com',status:'active'};
    r.provider.readRoutingMxRecords=async()=>{r.calls.push('provider.mxRead');return bad;};
    await rejected(r,'email_hostname_mx_not_ready',{noWrites:true});
    assert.equal(r.calls.includes('provider.destination'),false);
  }
  const noPermission=rig(row('email'));noPermission.state.domain={name:'example.com',status:'active'};
  delete noPermission.provider.readRoutingMxRecords;
  await rejected(noPermission,'email_permissions_required',{noWrites:true});
});

test('trailing DNS presentation dot on Cloudflare MX content is accepted', async () => {
  const r=rig(row('email'));r.state.domain={name:'example.com',status:'active'};
  r.provider.readRoutingMxRecords=async (_zone, hostname)=>
    routingMx(hostname).map(mx=>({...mx,content:mx.content+'.'}));
  const out=await consumeStoredToolkitApproval(r.api);
  assert.equal(out.status,'routing_rule_recorded');
  assert.equal(r.calls.filter(c=>c==='provider.createRule').length,1);
});

test('email does not mark an unverified, wrong-zone, or replaced rule as applied', async () => {
  for (const mutate of [
    rule=>({...rule,zone:{tag:'c'.repeat(32)}}),
    rule=>({...rule,id:'another-rule'}),
    rule=>({...rule,actions:[{type:'forward',value:['attacker@example.net']}]}),
    rule=>({...rule,enabled:false})
  ]) {
    const r=rig(row('email'));r.state.domain={name:'example.com',status:'active'};
    const original=r.provider.readEmailRoutingRule;
    let calls=0;
    r.provider.readEmailRoutingRule=async (...args)=>{
      const record=await original(...args);
      return ++calls===1 ? record : mutate(record);
    };
    await rejected(r,'email_rule_unverified');
    assert.equal(r.calls.includes('store.finish'),false);
    assert.equal(r.calls.includes('store.fail'),true);
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

const FORM_WRITES = ['provider.turnstile', 'provider.d1', 'provider.schema'];

test('forms stage resources with receipts and return an exact Worker review', async () => {
  const review = row('forms');
  const r = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review)});
  const out = await consumeStoredToolkitApproval(r.api);
  assert.equal(out.kind, 'forms');
  assert.equal(out.status, 'form_resources_staged');
  assert.equal(out.workingForm, false);
  assert.equal(out.workerReview.readyForProviderWrite, false);
  assert.equal(out.workerReview.bindings.find(binding => binding.name === 'DB').id, formsDatabaseId);
  assert.deepEqual(r.calls.filter(s => FORM_WRITES.includes(s)), FORM_WRITES);
  assert.equal(r.calls.filter(s => s === 'receipt.record').length, 4);
  assert.equal(JSON.stringify(out).includes('not-in-response'), false);
  assert.equal(JSON.stringify(r.state.receipt).includes('not-in-response'), false);
  assert.equal(r.state.finished.status, 'form_resources_staged');
});

test('interrupted forms staging resumes from receipts without recreating resources', async () => {
  const review = row('forms');
  const r = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review)});
  r.provider.applyCustomerSchema = async () => {
    r.calls.push('provider.schema');
    throw Object.assign(new Error('x'), {code: 'provider_temporarily_unavailable'});
  };
  await assert.rejects(consumeStoredToolkitApproval(r.api), e => e.code === 'provider_temporarily_unavailable');
  assert.equal(r.calls.includes('store.fail'), true);
  assert.deepEqual([r.state.receipt.widgetSitekey, r.state.receipt.databaseId, r.state.receipt.schemaApplied],
    ['widgetkey', formsDatabaseId, false]);

  const again = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review)});
  again.state.receipt = r.state.receipt;
  const out = await consumeStoredToolkitApproval(again.api);
  assert.equal(out.status, 'form_resources_staged');
  assert.deepEqual(again.calls.filter(s => FORM_WRITES.includes(s)), ['provider.schema']);

  const changed = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review)});
  changed.state.receipt = {...r.state.receipt, gateApprovalId: 'other-gate'};
  await rejected(changed, 'forms_gate_changed_reconcile', {noWrites: true});
  const bare = rig(review, {verifyFormsCostPrivacyGate: async () => gate(review), formsReceipts: undefined});
  await rejected(bare, 'forms_receipts_required', {noProvider: true});

  const custom = row('forms', {hostname: 'example.com'});
  const unsupported = rig(custom, {verifyFormsCostPrivacyGate: async () => gate(custom)});
  await rejected(unsupported, 'forms_hostname_not_active', {noProvider: true});
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
