import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {CUSTOMER_FORM_WORKER_SOURCE} from './customer-form-worker-source.mjs';
import {
  CUSTOMER_FORM_SCHEMA_SQL, FORM_WORKER_CRON, SITEVERIFY_URL, formWorkerUpload, formsResourceNames,
  isApprovedFormsMutation
} from './forms-provider-plan.mjs';
import {createCloudflareExtensionProvider} from './cloudflare-extension-provider.mjs';

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const PROJECT = 'esp-willow-site';
const HOST = PROJECT + '.pages.dev';
const DBID = '11111111-2222-3333-4444-555555555555';
const SECRET = '0x4AAAAAAA-test-secret';
const gate = {approvalId: 'gate_approval_0001', retentionDays: 30, maxSubmissionsPerDay: 20, maxBodyBytes: 8192};
const site = {cloudflareAccountId: ACCOUNT, githubUserId: 42, githubLogin: 'owner', pagesProjectName: PROJECT,
  repositoryName: 'esp-willow', productionBranch: 'main'};
const principal = {githubUserId: 42, githubLogin: 'owner', cloudflareAccountId: ACCOUNT};
const deployConfig = {hostname: HOST, databaseId: DBID, secret: SECRET, siteverifyUrl: SITEVERIFY_URL,
  maxBodyBytes: gate.maxBodyBytes, maxSubmissionsPerDay: gate.maxSubmissionsPerDay,
  retentionDays: gate.retentionDays, gateApprovalId: gate.approvalId, ownerEmail: 'owner@example.net'};

test('schema constant matches the reviewed .sql file byte for byte', () => {
  assert.equal(CUSTOMER_FORM_SCHEMA_SQL,
    readFileSync(new URL('./customer-form-d1-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual(formsResourceNames(PROJECT), {widget: 'launch-and-own-form-' + PROJECT,
    database: PROJECT + '-forms', script: PROJECT + '-form'});
  assert.throws(() => formsResourceNames('launch-and-own-onboarding-beta'), /owned_project_required/);
});

test('approval matcher allows only the exact forms mutations for this grant and gate', async () => {
  const names = formsResourceNames(PROJECT);
  const root = '/accounts/' + ACCOUNT;
  const base = {accountId: ACCOUNT, pagesProjectName: PROJECT, hostname: HOST, gate};
  const ok = (method, path, requestBody) => isApprovedFormsMutation({...base, method, path, requestBody});
  const {approvalBody} = await formWorkerUpload(deployConfig);
  assert.equal(JSON.stringify(approvalBody).includes(SECRET), false);

  assert.equal(await ok('POST', root + '/challenges/widgets', {name: names.widget, domains: [HOST], mode: 'managed'}), true);
  assert.equal(await ok('POST', root + '/d1/database', {name: names.database}), true);
  assert.equal(await ok('POST', root + '/d1/database/' + DBID + '/query', {sql: CUSTOMER_FORM_SCHEMA_SQL}), true);
  assert.equal(await ok('PUT', root + '/workers/scripts/' + names.script, approvalBody), true);
  assert.equal(await ok('PUT', root + '/workers/scripts/' + names.script + '/schedules', [{cron: FORM_WORKER_CRON}]), true);
  assert.equal(await ok('POST', root + '/workers/scripts/' + names.script + '/subdomain',
    {enabled: true, previews_enabled: false}), true);

  // Variations are refused.
  assert.equal(await ok('POST', root + '/challenges/widgets', {name: names.widget, domains: [HOST, 'evil.example'], mode: 'managed'}), false);
  assert.equal(await ok('POST', root + '/challenges/widgets', {name: names.widget, domains: [HOST], mode: 'invisible'}), false);
  assert.equal(await ok('POST', root + '/d1/database', {name: 'launch-and-own-onboarding-beta'}), false);
  assert.equal(await ok('POST', root + '/d1/database/' + DBID + '/query', {sql: 'DROP TABLE contact_submissions'}), false);
  assert.equal(await ok('PUT', root + '/workers/scripts/launch-and-own-onboarding-beta', approvalBody), false);
  assert.equal(await ok('PUT', root + '/workers/scripts/' + names.script, {...approvalBody, moduleSha256: 'f'.repeat(64)}), false);
  const looser = structuredClone(approvalBody);
  looser.metadata.bindings.find(b => b.name === 'RETENTION_DAYS').text = '365';
  assert.equal(await ok('PUT', root + '/workers/scripts/' + names.script, looser), false);
  const extra = structuredClone(approvalBody);
  extra.metadata.bindings.push({type: 'plain_text', name: 'DEBUG', text: '1'});
  assert.equal(await ok('PUT', root + '/workers/scripts/' + names.script, extra), false);
  assert.equal(await isApprovedFormsMutation({...base, gate: null, method: 'PUT',
    path: root + '/workers/scripts/' + names.script, requestBody: approvalBody}), false);
  assert.equal(await isApprovedFormsMutation({...base, hostname: 'example.com', method: 'POST',
    path: root + '/d1/database', requestBody: {name: names.database}}), false);
  assert.equal(await ok('DELETE', root + '/d1/database/' + DBID, undefined), false);
  assert.equal(await ok('POST', root + '/workers/scripts/' + names.script + '/subdomain',
    {enabled: true, previews_enabled: true}), false);
});

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(CUSTOMER_FORM_SCHEMA_SQL);
  return {sqlite, prepare: sql => ({bind: (...a) => ({
    first: async () => sqlite.prepare(sql).get(...a) || null,
    run: async () => sqlite.prepare(sql).run(...a)
  })})};
}

async function loadWorker() {
  return (await import('data:text/javascript;base64,' +
    Buffer.from(CUSTOMER_FORM_WORKER_SOURCE).toString('base64'))).default;
}

function submission(fields, origin = 'https://' + HOST) {
  const body = new URLSearchParams({name: 'Ada', email: 'ada@example.net', message: 'Hello there',
    'cf-turnstile-response': 'tok_' + 'a'.repeat(40), ...fields});
  return new Request('https://' + PROJECT + '-form.acct.workers.dev/submit', {method: 'POST',
    headers: {origin, 'content-type': 'application/x-www-form-urlencoded'}, body});
}

test('deployable form Worker: Siteverify-gated, origin-locked, single-use, limited, purged', async t => {
  const worker = await loadWorker();
  const DB = fakeD1();
  const env = {DB, TURNSTILE_SECRET: SECRET, SITE_HOSTNAME: HOST, MAX_BODY_BYTES: '8192',
    MAX_SUBMISSIONS_PER_DAY: '2', RETENTION_DAYS: '30', GATE_APPROVAL_ID: gate.approvalId};
  let verdict = {success: true, hostname: HOST};
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, SITEVERIFY_URL);
    sent.push(Object.fromEntries(init.body));
    return Response.json(verdict);
  });
  const health = async () => (await worker.fetch(new Request('https://w/health'), env)).json();
  assert.equal((await health()).hasAcceptedSubmission, false);

  const ok = await worker.fetch(submission({}), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://' + HOST);
  assert.equal(sent[0].secret, SECRET);
  const h = await health();
  assert.deepEqual([h.hasAcceptedSubmission, h.d1Bound, h.secretBound], [true, true, true]);
  assert.equal(JSON.stringify(h).includes(SECRET), false);

  assert.equal((await worker.fetch(submission({}), env)).status, 403, 'token reuse');
  assert.equal((await worker.fetch(submission({'cf-turnstile-response': 'tok_' + 'b'.repeat(40)},
    'https://evil.example'), env)).status, 403, 'foreign origin');
  verdict = {success: true, hostname: 'evil.example'};
  assert.equal((await worker.fetch(submission({'cf-turnstile-response': 'tok_' + 'c'.repeat(40)}), env)).status, 403);
  verdict = {success: false, 'error-codes': ['invalid-input-response']};
  assert.equal((await worker.fetch(submission({'cf-turnstile-response': 'tok_' + 'd'.repeat(40)}), env)).status, 403);
  verdict = {success: true, hostname: HOST};
  assert.equal((await worker.fetch(submission({'cf-turnstile-response': 'tok_' + 'e'.repeat(40)}), env)).status, 200);
  assert.equal((await worker.fetch(submission({'cf-turnstile-response': 'tok_' + 'f'.repeat(40)}), env)).status, 429);
  assert.equal((await worker.fetch(submission({email: 'nope', 'cf-turnstile-response': 'tok_' + 'g'.repeat(40)}), env)).status, 400);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM contact_submissions').get().n, 2);

  DB.sqlite.prepare('UPDATE contact_submissions SET created_at = created_at - 31 * 86400').run();
  await worker.scheduled({}, env);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM contact_submissions').get().n, 0);
  const pre = await worker.fetch(new Request('https://w/submit', {method: 'OPTIONS',
    headers: {origin: 'https://evil.example'}}), env);
  assert.equal(pre.status, 403);
});

function providerHarness({approve = true, widgetsExisting = [], health} = {}) {
  const calls = [];
  const approvals = [];
  const names = formsResourceNames(PROJECT);
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push({method: init?.method || 'GET', path: u.pathname + u.search, body: init?.body});
    const ok = result => Response.json({success: true, result,
      result_info: {page: 1, total_pages: 1, count: Array.isArray(result) ? result.length : 1,
        total_count: Array.isArray(result) ? result.length : 1}});
    if (u.hostname.endsWith('.workers.dev')) return Response.json(health);
    if (u.pathname.endsWith('/challenges/widgets') && init?.method !== 'POST') return ok(widgetsExisting);
    if (u.pathname.endsWith('/challenges/widgets'))
      return ok({...JSON.parse(init.body), sitekey: '0x4AAAA-site', secret: SECRET});
    if (u.pathname.endsWith('/d1/database') && init?.method !== 'POST') return ok([]);
    if (u.pathname.endsWith('/d1/database')) return ok({uuid: DBID, name: names.database});
    if (u.pathname.endsWith('/query')) return ok([{success: true}]);
    if (u.pathname.endsWith('/schedules')) return ok({schedules: [{cron: FORM_WORKER_CRON}]});
    if (u.pathname.endsWith('/subdomain') && u.pathname.includes('/scripts/')) return ok({enabled: true});
    if (u.pathname.endsWith('/workers/subdomain')) return ok({subdomain: 'acct'});
    if (u.pathname.endsWith('/workers/scripts/' + names.script)) return ok({id: names.script});
    return new Response('{}', {status: 404});
  };
  const provider = createCloudflareExtensionProvider({principal, githubAccessToken: 'gh', cloudflareAccessToken: 'cf',
    fetchFn, assertOperatorApprovedExecution: async args => {
      approvals.push(args);
      return approve && isApprovedFormsMutation({...args, accountId: ACCOUNT, pagesProjectName: PROJECT,
        hostname: HOST, gate});
    }});
  return {provider, calls, approvals};
}

test('provider adapter: full forms path under exact approval, secrets never reach the approver', async () => {
  const h = providerHarness({health: {ok: true, hostname: HOST, d1Bound: true, secretBound: true,
    serverSiteverify: true, hasAcceptedSubmission: false}});
  const widget = await h.provider.createTurnstileWidget(site, {hostname: HOST});
  assert.equal(widget.secret, SECRET);
  const db = await h.provider.createCustomerD1(site, {});
  assert.equal(db.id, DBID);
  const worker = await h.provider.deployServerVerifiedFormWorker(site, {...deployConfig, sitekey: widget.sitekey});
  assert.equal(worker.endpoint, 'https://' + PROJECT + '-form.acct.workers.dev/submit');
  const accepted = await h.provider.verifyFormAcceptance(site, {hostname: HOST, workerId: worker.id, databaseId: db.id});
  assert.deepEqual(accepted, {serverSiteverify: true, customerD1Bound: true, endToEndAccepted: false});

  assert.equal(h.approvals.length, 6);
  assert.equal(JSON.stringify(h.approvals).includes(SECRET), false);
  const upload = h.calls.find(c => c.method === 'PUT' && c.path.endsWith('-form'));
  assert.ok(upload.body instanceof FormData);
  assert.equal(JSON.parse(await upload.body.get('metadata').text()).bindings
    .find(b => b.name === 'TURNSTILE_SECRET').text, SECRET);
});

test('provider adapter refuses without approval, on name collisions and on other hosts', async () => {
  const denied = providerHarness({approve: false});
  await assert.rejects(denied.provider.createTurnstileWidget(site, {hostname: HOST}), /separate_execution_approval_required/);
  assert.equal(denied.calls.filter(c => c.method !== 'GET').length, 0);
  const taken = providerHarness({widgetsExisting: [{name: 'launch-and-own-form-' + PROJECT}]});
  await assert.rejects(taken.provider.createTurnstileWidget(site, {hostname: HOST}), /turnstile_widget_exists_reconcile/);
  await assert.rejects(taken.provider.createTurnstileWidget(site, {hostname: 'example.com'}), /forms_hostname_not_active/);
  await assert.rejects(taken.provider.deployServerVerifiedFormWorker(site, {...deployConfig, retentionDays: 0}),
    /form_worker_config_invalid/);
  await assert.rejects(taken.provider.verifyFormAcceptance(site, {hostname: HOST, workerId: PROJECT + '-form'}),
    /form_worker_unverified/);
});
