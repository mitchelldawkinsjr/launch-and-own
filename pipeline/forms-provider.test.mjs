import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CUSTOMER_FORM_WORKER_SOURCE} from './customer-form-worker-source.mjs';
import {
  buildFormWorkerReview, CUSTOMER_FORM_SCHEMA_SQL, PLATFORM_D1_IDS, formsResourceNames, isApprovedFormsMutation
} from './forms-provider-plan.mjs';
import {createCloudflareExtensionProvider} from './cloudflare-extension-provider.mjs';

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const PROJECT = 'esp-willow-site';
const HOST = PROJECT + '.pages.dev';
const DBID = '11111111-2222-3333-4444-555555555555';
const SECRET = '0x4AAAAAAA-test-secret';
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const gate = {approvalId: 'gate_approval_0001', retentionDays: 30, maxSubmissionsPerDay: 20, maxBodyBytes: 8192};
const site = {cloudflareAccountId: ACCOUNT, githubUserId: 42, githubLogin: 'owner', pagesProjectName: PROJECT,
  repositoryName: 'esp-willow', productionBranch: 'main'};
const principal = {githubUserId: 42, githubLogin: 'owner', cloudflareAccountId: ACCOUNT};
const reviewConfig = {pagesProjectName: PROJECT, hostname: HOST, databaseId: DBID,
  maxBodyBytes: gate.maxBodyBytes, maxSubmissionsPerDay: gate.maxSubmissionsPerDay,
  retentionDays: gate.retentionDays, gateApprovalId: gate.approvalId};

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

const receiptFor = (fields = {}) => ({gateApprovalId: gate.approvalId, widgetSitekey: null,
  databaseId: null, schemaApplied: false, ...fields});

test('approval permits only the next staged write to the reviewed widget or customer D1', () => {
  const names = formsResourceNames(PROJECT);
  const root = '/accounts/' + ACCOUNT;
  const script = root + '/workers/scripts/' + names.script;
  const base = {accountId: ACCOUNT, pagesProjectName: PROJECT, hostname: HOST, gate};
  const allowed = (receipt, method, path, requestBody) =>
    isApprovedFormsMutation({...base, receipt, method, path, requestBody});
  const widgetPath = root + '/challenges/widgets';
  const widgetBody = {name: names.widget, domains: [HOST], mode: 'managed'};
  const databasePath = root + '/d1/database';
  const databaseBody = {name: names.database};
  const query = id => databasePath + '/' + id + '/query';
  const schema = {sql: CUSTOMER_FORM_SCHEMA_SQL};
  const withWidget = receiptFor({widgetSitekey: 'site-key'});
  const withDb = {...withWidget, databaseId: DBID};
  const staged = {...withDb, schemaApplied: true};

  assert.equal(allowed(receiptFor(), 'POST', widgetPath, widgetBody), true);
  assert.equal(allowed(withWidget, 'POST', databasePath, databaseBody), true);
  assert.equal(allowed(withDb, 'POST', query(DBID), schema), true);

  assert.equal(allowed(null, 'POST', widgetPath, widgetBody), false);
  assert.equal(allowed(receiptFor({gateApprovalId: 'wrong_gate_0001'}), 'POST', widgetPath, widgetBody), false);
  assert.equal(allowed(withWidget, 'POST', widgetPath, widgetBody), false);
  assert.equal(allowed(receiptFor(), 'POST', databasePath, databaseBody), false);
  assert.equal(allowed(withDb, 'POST', databasePath, databaseBody), false);
  assert.equal(allowed(staged, 'POST', query(DBID), schema), false);
  assert.equal(allowed(withDb, 'POST', query('99999999-2222-3333-4444-555555555555'), schema), false);
  for (const platform of PLATFORM_D1_IDS)
    assert.equal(allowed({...withWidget, databaseId: platform}, 'POST', query(platform), schema), false);

  assert.equal(allowed(receiptFor(), 'POST', widgetPath, {...widgetBody, domains: ['elsewhere.example']}), false);
  assert.equal(allowed(receiptFor(), 'POST', widgetPath, {...widgetBody, mode: 'invisible'}), false);
  assert.equal(allowed(withWidget, 'POST', databasePath, {name: 'launch-and-own-onboarding-beta'}), false);
  assert.equal(allowed(withDb, 'POST', query(DBID), {sql: 'SELECT COUNT(*) FROM contact_submissions'}), false);
  assert.equal(isApprovedFormsMutation({...base, hostname: 'example.com', receipt: withWidget,
    method: 'POST', path: databasePath, requestBody: databaseBody}), false);
  assert.equal(allowed(withDb, 'DELETE', databasePath + '/' + DBID), false);
  assert.equal(allowed(staged, 'PUT', script, {}), false);
  assert.equal(allowed(staged, 'PUT', script + '/schedules', [{cron: '17 3 * * *'}]), false);
  assert.equal(allowed(staged, 'POST', script + '/subdomain', {enabled: true, previews_enabled: false}), false);
});

test('separate Worker review binds its module, dedicated DB, hostname and consent limits', async () => {
  const review = await buildFormWorkerReview(reviewConfig);
  assert.equal(review.scriptName, PROJECT + '-form');
  assert.equal(review.moduleSha256, createHash('sha256').update(CUSTOMER_FORM_WORKER_SOURCE).digest('hex'));
  assert.equal(review.readyForProviderWrite, false);
  const bindings = Object.fromEntries(review.bindings.map(binding => [binding.name, binding]));
  assert.equal(bindings.DB.id, DBID);
  assert.equal(bindings.SITE_HOSTNAME.text, HOST);
  assert.equal(bindings.GATE_APPROVAL_ID.text, gate.approvalId);
  assert.equal(bindings.RETENTION_DAYS.text, String(gate.retentionDays));
  assert.equal(bindings.MAX_BODY_BYTES.text, String(gate.maxBodyBytes));
  assert.equal(bindings.MAX_SUBMISSIONS_PER_DAY.text, String(gate.maxSubmissionsPerDay));
  assert.deepEqual(bindings.TURNSTILE_SECRET, {type: 'secret_text', name: 'TURNSTILE_SECRET'});
  for (const invalid of [{databaseId: PLATFORM_D1_IDS[0]}, {hostname: 'other.pages.dev'}, {retentionDays: 0}])
    await assert.rejects(buildFormWorkerReview({...reviewConfig, ...invalid}), /form_worker_config_invalid/);
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

function providerHarness({approve = true, widgetsExisting = [], schemaResult = [{success: true}],
  receipt: initialReceipt = receiptFor()} = {}) {
  const calls = [];
  const approvals = [];
  const names = formsResourceNames(PROJECT);
  let receipt = initialReceipt;
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const method = init?.method || 'GET';
    calls.push({method, path: u.pathname + u.search, body: init?.body});
    const ok = result => Response.json({success: true, result,
      result_info: {page: 1, total_pages: 1, count: Array.isArray(result) ? result.length : 1,
        total_count: Array.isArray(result) ? result.length : 1}});
    if (u.pathname.endsWith('/challenges/widgets') && method === 'GET') return ok(widgetsExisting);
    if (u.pathname.endsWith('/challenges/widgets'))
      return ok({...JSON.parse(init.body), sitekey: '0x4AAAA-site', secret: SECRET});
    if (u.pathname.endsWith('/d1/database') && method === 'GET') return ok([]);
    if (u.pathname.endsWith('/d1/database')) return ok({uuid: DBID, name: names.database});
    if (u.pathname.endsWith('/query')) return ok(schemaResult);
    throw new Error('Unexpected fixture request');
  };
  const provider = createCloudflareExtensionProvider({principal, githubAccessToken: 'gh', cloudflareAccessToken: 'cf',
    fetchFn, assertOperatorApprovedExecution: async args => {
      approvals.push(args);
      return approve && isApprovedFormsMutation({...args, accountId: ACCOUNT, pagesProjectName: PROJECT,
        hostname: HOST, gate, receipt});
    }});
  return {provider, calls, approvals, setReceipt: value => { receipt = value; }};
}

test('provider stages only the exact widget and customer D1 under approval', async () => {
  const h = providerHarness();
  const widget = await h.provider.createTurnstileWidget(site, {hostname: HOST});
  assert.deepEqual(widget, {sitekey: '0x4AAAA-site'});
  h.setReceipt(receiptFor({widgetSitekey: widget.sitekey}));
  const database = await h.provider.createCustomerD1(site, {hostname: HOST});
  assert.equal(database.id, DBID);
  h.setReceipt(receiptFor({widgetSitekey: widget.sitekey, databaseId: DBID}));
  await h.provider.applyCustomerSchema(site, {hostname: HOST, databaseId: DBID});
  assert.equal(h.approvals.length, 3);
  assert.equal(JSON.stringify(h.approvals).includes(SECRET), false);
  assert.equal(h.calls.some(call => call.path.includes('/workers/')), false);
});

test('provider refuses staging with a missing grant, resource collision or unsupported host or database', async () => {
  const denied = providerHarness({approve: false});
  await assert.rejects(denied.provider.createTurnstileWidget(site, {hostname: HOST}), /separate_execution_approval_required/);
  assert.equal(denied.calls.filter(c => c.method !== 'GET').length, 0);
  const taken = providerHarness({widgetsExisting: [{name: 'launch-and-own-form-' + PROJECT}]});
  await assert.rejects(taken.provider.createTurnstileWidget(site, {hostname: HOST}), /turnstile_widget_exists_reconcile/);
  await assert.rejects(taken.provider.createTurnstileWidget(site, {hostname: 'example.com'}), /forms_hostname_not_active/);
  await assert.rejects(taken.provider.applyCustomerSchema(site, {hostname: HOST, databaseId: PLATFORM_D1_IDS[0]}),
    /customer_d1_unverified/);
  const noSchemaProof = providerHarness({schemaResult: [], receipt: receiptFor({widgetSitekey: 'site', databaseId: DBID})});
  await assert.rejects(noSchemaProof.provider.applyCustomerSchema(site, {hostname: HOST, databaseId: DBID}),
    /customer_d1_schema_unverified/);
});

test('form Worker keeps the site form\'s own fields and sends a browser form back to its page', async t => {
  const worker = await loadWorker();
  const DB = fakeD1();
  const env = workerEnv(DB, {MAX_SUBMISSIONS_PER_DAY: '10'});
  t.mock.method(globalThis, 'fetch', async () => Response.json({success: true, hostname: HOST}));
  const post = (fields, headers = {}) => worker.fetch(new Request('https://' + PROJECT + '-form.acct.workers.dev/submit', {
    method: 'POST', body: new URLSearchParams({'cf-turnstile-response': freshToken(), ...fields}),
    headers: {origin: 'https://' + HOST, 'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml', referer: 'https://' + HOST + '/contact?x=1', ...headers}}), env);
  // The Green Willow booking form: no message field, a date and a select.
  const sent = await post({name: 'Ada', email: 'ada@example.net', date: '2026-12-05', type: 'portrait'});
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get('location'), 'https://' + HOST + '/contact?form=sent');
  const row = DB.sqlite.prepare('SELECT fields_json, reply_email FROM contact_submissions').get();
  assert.deepEqual(JSON.parse(row.fields_json), {name: 'Ada', email: 'ada@example.net', date: '2026-12-05', type: 'portrait'});
  assert.equal(row.reply_email, 'ada@example.net');
  // A phone-only form works without an email field.
  assert.equal((await post({phone: '555-0142'})).headers.get('location'), 'https://' + HOST + '/contact?form=sent');
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM contact_submissions WHERE reply_email IS NULL').get().n, 1);
  // Errors go back to the page too; a foreign referer never becomes the redirect target.
  const bad = await post({email: 'nope'}, {referer: 'https://evil.example/x'});
  assert.equal(bad.headers.get('location'), 'https://' + HOST + '/?form=error&reason=email_invalid');
  assert.equal((await post({'bad name': 'x'})).headers.get('location').includes('reason=field_invalid'), true);
  assert.equal((await post({})).headers.get('location').includes('reason=form_empty'), true);
  const many = Object.fromEntries(Array.from({length: 21}, (_, i) => ['f' + i, 'x']));
  assert.equal((await post(many)).headers.get('location').includes('reason=too_many_fields'), true);
  // fetch() callers still get JSON.
  const api = await post({email: 'ada@example.net', message: 'Hi'}, {accept: 'application/json'});
  assert.deepEqual(await api.json(), {ok: true});
});
