import test from 'node:test';
import assert from 'node:assert/strict';
import {MESSAGES_SQL, readFormMessages, renderFormMessages} from './form-messages.mjs';
import {PLATFORM_D1_IDS} from '../pipeline/forms-provider-plan.mjs';
import {connectTenant, approvePreview, harness, newPreview, originalFetch, post} from './worker-test-support.mjs';

const DB = '11111111-2222-3333-4444-555555555555';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const row = (fields, extra = {}) => ({id: 'x', fields_json: JSON.stringify(fields), reply_email: fields.email ?? null, created_at: 1795600000, ...extra});

test('reads only the fixed query from the owner\'s form database and escapes what visitors sent', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({url, body: JSON.parse(init.body), auth: init.headers.authorization});
    return Response.json({success: true, result: [{results: [
      row({name: 'Ada <script>', email: 'ada@example.net', date: '2026-12-05'}),
      row({phone: '555'}), {id: 'bad', fields_json: 'not json', created_at: 1}
    ]}]});
  };
  const messages = await readFormMessages({accountId: 'a'.repeat(32), databaseId: DB, cloudflareToken: 'cf', fetchFn});
  assert.deepEqual(calls, [{url: 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/d1/database/' + DB + '/query',
    body: {sql: MESSAGES_SQL}, auth: 'Bearer cf'}]);
  assert.equal(messages.length, 2);
  const html = renderFormMessages(messages, {escape, databaseName: 'esp-x-site-forms'});
  assert.match(html, /<dt>name<\/dt><dd>Ada &lt;script&gt;<\/dd>/);
  assert.match(html, /<a href="mailto:ada@example\.net">Reply<\/a>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(renderFormMessages([], {escape, databaseName: 'db'}), /No messages yet/);
  await assert.rejects(readFormMessages({accountId: 'a'.repeat(32), databaseId: PLATFORM_D1_IDS[0], cloudflareToken: 'cf', fetchFn}), /form_service_not_ready/);
  await assert.rejects(readFormMessages({accountId: 'a'.repeat(32), databaseId: DB, cloudflareToken: 'cf',
    fetchFn: async () => new Response(null, {status: 403})}), /permission_required/);
});

test('the messages page shows only the owner\'s own site and never stores what it read', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const tenant = await connectTenant(h);
    const id = await newPreview(h, tenant);
    assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
    assert.equal((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);
    const none = await h.request('/form-messages?id=' + id, {cookie: tenant.cookie});
    assert.match(await none.text(), /Set up the contact form from Optional features first/);
    const job = h.sqlite.prepare('SELECT * FROM onboarding_launch_jobs WHERE id=?').get(id);
    const time = Math.floor(Date.now() / 1000);
    h.sqlite.prepare(`INSERT INTO onboarding_option_approvals(id,job_id,github_user_id,cloudflare_account_id,kind,
      approval_digest,payload_json,status,created_at,updated_at) VALUES ('forms-1',?,?,?,'forms',?,'{}','stored',?,?)`)
      .run(id, job.github_user_id, job.cloudflare_account_id, 'b'.repeat(64), time, time);
    h.sqlite.prepare(`INSERT INTO onboarding_forms_provisioning(forms_option_approval_id,job_id,github_user_id,
      cloudflare_account_id,gate_approval_id,widget_sitekey,database_id,schema_applied,worker_deployed,
      worker_subdomain_enabled,worker_schedule_set,worker_url,created_at,updated_at)
      VALUES ('forms-1',?,?,?,'gate_0001','0x4AAAAAAAtestkey',?,1,1,1,1,'https://esp-willow-studio-site-form.acct.workers.dev',?,?)`)
      .run(id, job.github_user_id, job.cloudflare_account_id, DB, time, time);
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => url.endsWith('/d1/database/' + DB + '/query')
      ? Response.json({success: true, result: [{results: [row({name: 'Ada', email: 'ada@example.net', message: 'Hello'})]}]})
      : inner(url, init);
    const page = await h.request('/form-messages?id=' + id, {cookie: tenant.cookie});
    const html = await page.text();
    assert.equal(page.status, 200, html);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(html, /<dd>Hello<\/dd>/);
    assert.match(html, /esp-willow-studio-site-forms/);
    const dump = JSON.stringify(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t =>
      h.sqlite.prepare('SELECT * FROM ' + t.name).all()));
    assert.equal(dump.includes('Hello'), false, 'nothing from the message is kept in onboarding D1');
    const stranger = await connectTenant(harness());
    assert.equal((await h.request('/form-messages?id=' + id, {cookie: stranger.cookie})).status, 404, 'no access without the owner session');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
