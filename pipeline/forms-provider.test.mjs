import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {CUSTOMER_FORM_WORKER_SOURCE} from './customer-form-worker-source.mjs';
import {
  ACCEPTANCE_SQL, CUSTOMER_FORM_SCHEMA_SQL, FORM_WORKER_CRON, PLATFORM_D1_IDS, SITEVERIFY_URL, formWorkerUpload,
  formsResourceNames, isApprovedFormsAcceptanceRead, isApprovedFormsMutation
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

test('schema constant matches the reviewed .sql file; platform D1 ids match wrangler config', () => {
  assert.equal(CUSTOMER_FORM_SCHEMA_SQL,
    readFileSync(new URL('./customer-form-d1-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual(formsResourceNames(PROJECT), {widget: 'launch-and-own-form-' + PROJECT,
    database: PROJECT + '-forms', script: PROJECT + '-form'});
  assert.throws(() => formsResourceNames('launch-and-own-onboarding-beta'), /owned_project_required/);
  for (const file of ['../onboarding/wrangler.jsonc', '../integration/wrangler.bridge.jsonc']) {
    const id = readFileSync(new URL(file, import.meta.url), 'utf8').match(/"database_id":\s*"([^"]+)"/)[1];
    assert.ok(PLATFORM_D1_IDS.includes(id), file);
  }
  // Re-applying the schema after an interrupted run is harmless.
  const db = new DatabaseSync(':memory:');
  db.exec(CUSTOMER_FORM_SCHEMA_SQL);
  db.exec(CUSTOMER_FORM_SCHEMA_SQL);
});

const R = (o = {}) => ({gateApprovalId: gate.approvalId, widgetSitekey: null, databaseId: null,
  schemaApplied: false, workerEtag: null, endpoint: null, acceptedAt: null, ...o});

test('approval matcher allows each forms write only at its own step, bound to the recorded customer D1', async () => {
  const names = formsResourceNames(PROJECT);
  const root = '/accounts/' + ACCOUNT;
  const script = root + '/workers/scripts/' + names.script;
  const base = {accountId: ACCOUNT, pagesProjectName: PROJECT, hostname: HOST, gate};
  const ok = (receipt, method, path, requestBody) =>
    isApprovedFormsMutation({...base, receipt, method, path, requestBody});
  const {approvalBody} = await formWorkerUpload(deployConfig);
  assert.equal(JSON.stringify(approvalBody).includes(SECRET), false);
  const widgetBody = {name: names.widget, domains: [HOST], mode: 'managed'};
  const query = id => root + '/d1/database/' + id + '/query';

  // Happy path, step by step.
  assert.equal(await ok(R(), 'POST', root + '/challenges/widgets', widgetBody), true);
  assert.equal(await ok(R({widgetSitekey: 'site'}), 'POST', root + '/d1/database', {name: names.database}), true);
  const withDb = R({widgetSitekey: 'site', databaseId: DBID});
  assert.equal(await ok(withDb, 'POST', query(DBID), {sql: CUSTOMER_FORM_SCHEMA_SQL}), true);
  const schemaDone = {...withDb, schemaApplied: true};
  assert.equal(await ok(schemaDone, 'PUT', script, approvalBody), true);
  const deployed = {...schemaDone, workerEtag: 'etag1'};
  assert.equal(await ok(deployed, 'PUT', script + '/schedules', [{cron: FORM_WORKER_CRON}]), true);
  assert.equal(await ok(deployed, 'POST', script + '/subdomain', {enabled: true, previews_enabled: false}), true);

  // No receipt, another gate, or a step already done: refused.
  assert.equal(await ok(null, 'POST', root + '/challenges/widgets', widgetBody), false);
  assert.equal(await ok(R({gateApprovalId: 'other_gate_0001'}), 'POST', root + '/challenges/widgets', widgetBody), false);
  assert.equal(await ok(R({widgetSitekey: 'site'}), 'POST', root + '/challenges/widgets', widgetBody), false);
  assert.equal(await ok(R(), 'POST', root + '/d1/database', {name: names.database}), false, 'D1 before widget');
  assert.equal(await ok(withDb, 'POST', root + '/d1/database', {name: names.database}), false, 'second D1');
  assert.equal(await ok(schemaDone, 'POST', query(DBID), {sql: CUSTOMER_FORM_SCHEMA_SQL}), false, 'schema twice');
  assert.equal(await ok(withDb, 'PUT', script, approvalBody), false, 'worker before schema');
  assert.equal(await ok(deployed, 'PUT', script, approvalBody), false, 'worker replaced');
  assert.equal(await ok(schemaDone, 'PUT', script + '/schedules', [{cron: FORM_WORKER_CRON}]), false);
  assert.equal(await ok({...deployed, endpoint: 'https://x/submit'}, 'POST', script + '/subdomain',
    {enabled: true, previews_enabled: false}), false);

  // Wrong or platform databases: refused for the schema query and the Worker binding.
  const other = '99999999-2222-3333-4444-555555555555';
  assert.equal(await ok(withDb, 'POST', query(other), {sql: CUSTOMER_FORM_SCHEMA_SQL}), false);
  for (const platform of PLATFORM_D1_IDS) {
    const r = R({widgetSitekey: 'site', databaseId: platform});
    assert.equal(await ok(r, 'POST', query(platform), {sql: CUSTOMER_FORM_SCHEMA_SQL}), false);
    const {approvalBody: onPlatform} = await formWorkerUpload({...deployConfig, databaseId: platform});
    assert.equal(await ok({...r, schemaApplied: true}, 'PUT', script, onPlatform), false);
  }
  const {approvalBody: otherDb} = await formWorkerUpload({...deployConfig, databaseId: other});
  assert.equal(await ok(schemaDone, 'PUT', script, otherDb), false, 'binding to another D1');

  // Body variations are refused.
  assert.equal(await ok(R(), 'POST', root + '/challenges/widgets', {...widgetBody, domains: [HOST, 'evil.example']}), false);
  assert.equal(await ok(R(), 'POST', root + '/challenges/widgets', {...widgetBody, mode: 'invisible'}), false);
  assert.equal(await ok(R({widgetSitekey: 'site'}), 'POST', root + '/d1/database', {name: 'launch-and-own-onboarding-beta'}), false);
  assert.equal(await ok(withDb, 'POST', query(DBID), {sql: 'DROP TABLE contact_submissions'}), false);
  assert.equal(await ok(schemaDone, 'PUT', root + '/workers/scripts/launch-and-own-onboarding-beta', approvalBody), false);
  assert.equal(await ok(schemaDone, 'PUT', script, {...approvalBody, moduleSha256: 'f'.repeat(64)}), false);
  const looser = structuredClone(approvalBody);
  looser.metadata.bindings.find(b => b.name === 'RETENTION_DAYS').text = '365';
  assert.equal(await ok(schemaDone, 'PUT', script, looser), false);
  const extra = structuredClone(approvalBody);
  extra.metadata.bindings.push({type: 'plain_text', name: 'DEBUG', text: '1'});
  assert.equal(await ok(schemaDone, 'PUT', script, extra), false);
  assert.equal(await isApprovedFormsMutation({...base, gate: null, receipt: schemaDone, method: 'PUT',
    path: script, requestBody: approvalBody}), false);
  assert.equal(await isApprovedFormsMutation({...base, hostname: 'example.com', receipt: R({widgetSitekey: 's'}),
    method: 'POST', path: root + '/d1/database', requestBody: {name: names.database}}), false);
  assert.equal(await ok(withDb, 'DELETE', root + '/d1/database/' + DBID, undefined), false);
  assert.equal(await ok(deployed, 'POST', script + '/subdomain', {enabled: true, previews_enabled: true}), false);

  // Acceptance read: exactly one SELECT on the recorded customer D1.
  const read = {method: 'POST', accountId: ACCOUNT, databaseId: DBID, gateApprovalId: gate.approvalId, hostname: HOST,
    path: query(DBID), requestBody: {sql: ACCEPTANCE_SQL, params: [gate.approvalId, HOST]}};
  assert.equal(isApprovedFormsAcceptanceRead(read), true);
  assert.equal(isApprovedFormsAcceptanceRead({...read, requestBody: {sql: 'DELETE FROM contact_submissions'}}), false);
  assert.equal(isApprovedFormsAcceptanceRead({...read, path: query(other)}), false);
  assert.equal(isApprovedFormsAcceptanceRead({...read, databaseId: PLATFORM_D1_IDS[0],
    path: query(PLATFORM_D1_IDS[0])}), false);
});

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(CUSTOMER_FORM_SCHEMA_SQL);
  const stmt = (sql, a = []) => ({
    bind: (...b) => stmt(sql, b),
    first: async () => sqlite.prepare(sql).get(...a) || null,
    run: async () => ({success: true, meta: {changes: Number(sqlite.prepare(sql).run(...a).changes)}}),
    _exec: () => ({success: true, meta: {changes: Number(sqlite.prepare(sql).run(...a).changes)}})
  });
  return {sqlite, prepare: sql => stmt(sql), async batch(list) {
    // D1 batches run as one transaction.
    sqlite.exec('BEGIN');
    try { const out = list.map(s => s._exec()); sqlite.exec('COMMIT'); return out; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
}

async function loadWorker() {
  return (await import('data:text/javascript;base64,' +
    Buffer.from(CUSTOMER_FORM_WORKER_SOURCE).toString('base64'))).default;
}

let tokenSeq = 0;
const freshToken = () => 'tok_' + String(++tokenSeq).padStart(40, '0');
function submission(fields, origin = 'https://' + HOST) {
  const body = new URLSearchParams({name: 'Ada', email: 'ada@example.net', message: 'Hello there',
    'cf-turnstile-response': freshToken(), ...fields});
  return new Request('https://' + PROJECT + '-form.acct.workers.dev/submit', {method: 'POST',
    headers: {origin, 'content-type': 'application/x-www-form-urlencoded'}, body});
}

function workerEnv(DB, overrides = {}) {
  return {DB, TURNSTILE_SECRET: SECRET, SITE_HOSTNAME: HOST, MAX_BODY_BYTES: '8192',
    MAX_SUBMISSIONS_PER_DAY: '2', RETENTION_DAYS: '30', GATE_APPROVAL_ID: gate.approvalId, ...overrides};
}
const count = (DB, table) => DB.sqlite.prepare('SELECT count(*) n FROM ' + table).get().n;

test('deployable form Worker: Siteverify-gated, origin-locked, single-use, limited, purged', async t => {
  const worker = await loadWorker();
  const DB = fakeD1();
  const env = workerEnv(DB);
  let verdict = {success: true, hostname: HOST};
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, SITEVERIFY_URL);
    sent.push(Object.fromEntries(init.body));
    return Response.json(verdict);
  });
  const health = await (await worker.fetch(new Request('https://w/health'), env)).json();
  assert.deepEqual(health, {ok: true}, 'health is liveness only');

  const reused = freshToken();
  const ok = await worker.fetch(submission({'cf-turnstile-response': reused}), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://' + HOST);
  assert.equal(sent[0].secret, SECRET);

  assert.equal((await worker.fetch(submission({'cf-turnstile-response': reused}), env)).status, 403, 'token reuse');
  assert.equal(sent.length, 1, 'reused token never reaches Siteverify');
  assert.equal((await worker.fetch(submission({}, 'https://evil.example'), env)).status, 403, 'foreign origin');
  verdict = {success: true, hostname: 'evil.example'};
  assert.equal((await worker.fetch(submission({}), env)).status, 403);
  verdict = {success: false, 'error-codes': ['invalid-input-response']};
  assert.equal((await worker.fetch(submission({}), env)).status, 403);
  assert.equal(count(DB, 'turnstile_token_uses'), 1, 'rejected tokens are not persisted');
  verdict = {success: true, hostname: HOST};
  assert.equal((await worker.fetch(submission({}), env)).status, 200);
  assert.equal((await worker.fetch(submission({}), env)).status, 429);
  assert.equal((await worker.fetch(submission({email: 'nope'}), env)).status, 400);
  assert.equal(count(DB, 'contact_submissions'), 2);
  assert.equal(count(DB, 'turnstile_token_uses'), 2);

  DB.sqlite.prepare('UPDATE contact_submissions SET created_at = created_at - 31 * 86400').run();
  await worker.scheduled({}, env);
  assert.equal(count(DB, 'contact_submissions'), 0);
  const pre = await worker.fetch(new Request('https://w/submit', {method: 'OPTIONS',
    headers: {origin: 'https://evil.example'}}), env);
  assert.equal(pre.status, 403);
});

test('form Worker: concurrent submissions cannot exceed the daily cap', async t => {
  const worker = await loadWorker();
  const DB = fakeD1();
  const env = workerEnv(DB, {MAX_SUBMISSIONS_PER_DAY: '3'});
  // Every request passes the early count check before any write lands.
  t.mock.method(globalThis, 'fetch', async () => {
    await new Promise(r => setTimeout(r, 5));
    return Response.json({success: true, hostname: HOST});
  });
  const statuses = (await Promise.all(Array.from({length: 8}, () => worker.fetch(submission({}), env))))
    .map(r => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429, 429, 429]);
  assert.equal(count(DB, 'contact_submissions'), 3);
  assert.equal(count(DB, 'turnstile_token_uses'), 3, 'replay state only for written submissions');
});

test('form Worker: oversized bodies are refused by actual bytes, before Siteverify', async t => {
  const worker = await loadWorker();
  const DB = fakeD1();
  const env = workerEnv(DB, {MAX_BODY_BYTES: '256'});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({success: true, hostname: HOST}));
  // Streamed body: no content-length header to trust.
  const big = new TextEncoder().encode('name=Ada&email=a%40b.co&message=' + 'x'.repeat(10000) +
    '&cf-turnstile-response=' + freshToken());
  const stream = new ReadableStream({start(c) { for (let i = 0; i < big.length; i += 1000) c.enqueue(big.slice(i, i + 1000)); c.close(); }});
  const req = new Request('https://w/submit', {method: 'POST', body: stream, duplex: 'half',
    headers: {origin: 'https://' + HOST, 'content-type': 'application/x-www-form-urlencoded'}});
  assert.equal(req.headers.get('content-length'), null);
  assert.equal((await worker.fetch(req, env)).status, 413);
  // Under the envelope but over the field budget.
  assert.equal((await worker.fetch(submission({message: 'y'.repeat(1000)}), env)).status, 413);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(count(DB, 'contact_submissions') + count(DB, 'turnstile_token_uses'), 0);
});

test('form Worker: Siteverify outage or malformed reply fails closed without replay state', async t => {
  const worker = await loadWorker();
  const DB = fakeD1();
  const env = workerEnv(DB);
  const replies = [() => new Response('oops', {status: 500}), () => new Response('not json'),
    () => { throw new Error('network'); }, () => Response.json({success: 'true', hostname: HOST})];
  let i = 0;
  t.mock.method(globalThis, 'fetch', async () => replies[i++]());
  for (let n = 0; n < replies.length; n++)
    assert.equal((await worker.fetch(submission({}), env)).status, 403);
  assert.equal(count(DB, 'contact_submissions') + count(DB, 'turnstile_token_uses'), 0);
});

function providerHarness({approve = true, widgetsExisting = [], scriptExists = false, settings, acceptedRows = 0,
  receipt: start = R()} = {}) {
  const calls = [];
  const approvals = [];
  const names = formsResourceNames(PROJECT);
  let receipt = start;
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const method = init?.method || 'GET';
    calls.push({method, path: u.pathname + u.search, body: init?.body});
    const ok = result => Response.json({success: true, result,
      result_info: {page: 1, total_pages: 1, count: Array.isArray(result) ? result.length : 1,
        total_count: Array.isArray(result) ? result.length : 1}});
    if (u.pathname.endsWith('/challenges/widgets') && method !== 'POST') return ok(widgetsExisting);
    if (u.pathname.endsWith('/challenges/widgets'))
      return ok({...JSON.parse(init.body), sitekey: '0x4AAAA-site', secret: SECRET});
    if (u.pathname.endsWith('/challenges/widgets/0x4AAAA-site'))
      return ok({sitekey: '0x4AAAA-site', secret: SECRET, name: names.widget, domains: [HOST], mode: 'managed'});
    if (u.pathname.endsWith('/d1/database') && method !== 'POST') return ok([]);
    if (u.pathname.endsWith('/d1/database')) return ok({uuid: DBID, name: names.database});
    if (u.pathname.endsWith('/query') && JSON.parse(init.body).sql === ACCEPTANCE_SQL)
      return ok([{success: true, results: [{n: acceptedRows}]}]);
    if (u.pathname.endsWith('/query')) return ok([{success: true}]);
    if (u.pathname.endsWith('/settings'))
      return scriptExists || settings ? ok(settings || {bindings: []}) : new Response('{}', {status: 404});
    if (u.pathname.endsWith('/schedules')) return ok({schedules: [{cron: FORM_WORKER_CRON}]});
    if (u.pathname.endsWith('/subdomain') && u.pathname.includes('/scripts/')) return ok({enabled: true});
    if (u.pathname.endsWith('/workers/subdomain')) return ok({subdomain: 'acct'});
    if (u.pathname.endsWith('/workers/scripts/' + names.script)) return ok({id: names.script, etag: 'etag1'});
    return new Response('{}', {status: 404});
  };
  const provider = createCloudflareExtensionProvider({principal, githubAccessToken: 'gh', cloudflareAccessToken: 'cf',
    fetchFn, assertOperatorApprovedExecution: async args => {
      approvals.push(args);
      if (args.requestBody?.sql === ACCEPTANCE_SQL)
        return approve && isApprovedFormsAcceptanceRead({...args, accountId: ACCOUNT, databaseId: DBID,
          gateApprovalId: gate.approvalId, hostname: HOST});
      return approve && isApprovedFormsMutation({...args, accountId: ACCOUNT, pagesProjectName: PROJECT,
        hostname: HOST, gate, receipt});
    }});
  return {provider, calls, approvals, setReceipt: r => { receipt = r; }};
}

test('provider adapter: each step under exact approval, secrets never reach the approver', async () => {
  const h = providerHarness();
  const widget = await h.provider.createTurnstileWidget(site, {hostname: HOST});
  assert.equal(widget.secret, SECRET);
  h.setReceipt(R({widgetSitekey: widget.sitekey}));
  const db = await h.provider.createCustomerD1(site, {hostname: HOST});
  assert.equal(db.id, DBID);
  h.setReceipt(R({widgetSitekey: widget.sitekey, databaseId: DBID}));
  await h.provider.applyCustomerSchema(site, {hostname: HOST, databaseId: DBID});
  h.setReceipt(R({widgetSitekey: widget.sitekey, databaseId: DBID, schemaApplied: true}));
  const resumed = await h.provider.readTurnstileSecret(site, {hostname: HOST, sitekey: widget.sitekey});
  assert.equal(resumed.secret, SECRET);
  const worker = await h.provider.deployServerVerifiedFormWorker(site, {...deployConfig, sitekey: widget.sitekey});
  assert.deepEqual(worker, {id: PROJECT + '-form', etag: 'etag1'});
  h.setReceipt(R({widgetSitekey: widget.sitekey, databaseId: DBID, schemaApplied: true, workerEtag: 'etag1'}));
  const published = await h.provider.publishFormWorker(site, {hostname: HOST});
  assert.equal(published.endpoint, 'https://' + PROJECT + '-form.acct.workers.dev/submit');

  assert.equal(h.approvals.length, 6);
  assert.equal(JSON.stringify(h.approvals).includes(SECRET), false);
  const upload = h.calls.find(c => c.method === 'PUT' && c.path.endsWith('-form'));
  assert.ok(upload.body instanceof FormData);
  assert.equal(JSON.parse(await upload.body.get('metadata').text()).bindings
    .find(b => b.name === 'TURNSTILE_SECRET').text, SECRET);
});

test('provider adapter: never replaces an existing same-name Worker', async () => {
  const h = providerHarness({scriptExists: true,
    receipt: R({widgetSitekey: 's', databaseId: DBID, schemaApplied: true})});
  await assert.rejects(h.provider.deployServerVerifiedFormWorker(site, deployConfig), /form_worker_exists_reconcile/);
  assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0);
});

test('provider adapter: acceptance reads the deployed bindings and the customer D1, not a public endpoint', async () => {
  const bindings = [{type: 'd1', name: 'DB', id: DBID}, {type: 'plain_text', name: 'SITE_HOSTNAME', text: HOST},
    {type: 'plain_text', name: 'GATE_APPROVAL_ID', text: gate.approvalId}, {type: 'secret_text', name: 'TURNSTILE_SECRET'}];
  const args = {hostname: HOST, databaseId: DBID, gateApprovalId: gate.approvalId};
  const none = providerHarness({settings: {bindings}, acceptedRows: 0});
  assert.deepEqual(await none.provider.verifyFormAcceptance(site, args), {workerBound: true, accepted: false});
  const yes = providerHarness({settings: {bindings}, acceptedRows: 1});
  assert.deepEqual(await yes.provider.verifyFormAcceptance(site, args), {workerBound: true, accepted: true});
  assert.equal(yes.calls.some(c => c.path.includes('workers.dev')), false);
  const swapped = providerHarness({settings: {bindings: bindings.map(b => b.name === 'DB'
    ? {...b, id: '99999999-2222-3333-4444-555555555555'} : b)}, acceptedRows: 1});
  assert.deepEqual(await swapped.provider.verifyFormAcceptance(site, args), {workerBound: false, accepted: false});
  assert.equal(swapped.calls.filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(yes.provider.verifyFormAcceptance(site, {...args, databaseId: PLATFORM_D1_IDS[0]}),
    /customer_d1_unverified/);
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
  await assert.rejects(taken.provider.applyCustomerSchema(site, {hostname: HOST, databaseId: PLATFORM_D1_IDS[0]}),
    /customer_d1_unverified/);
});
