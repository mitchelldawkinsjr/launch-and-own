import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {bridgeLaunchStatus, importBridgeDraft} from './bridge-draft-review.mjs';
import {createMemoryD1} from '../integration/d1-support.mjs';
import {D1SiteDraftStore} from '../integration/d1-site-draft-store.mjs';
import {createBridgeHost, handleBridgeRequest, MemoryAgentTokenStore} from '../integration/bridge-transport.mjs';
import {mintOwnerTicket} from '../integration/draft-handoff.mjs';
import {BRIDGE_AUDIENCE} from '../integration/tool-contract.mjs';
import {sha256} from './crypto.mjs';

const KEY = 'ef'.repeat(32);
const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const now = () => Math.floor(Date.now() / 1000);
const owner = {githubUserId: 42, cloudflareAccountId: ACCOUNT, authorizationEpoch: 0, reauthorized: true};

function onboardingDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE onboarding_launches (id TEXT PRIMARY KEY, session_hash TEXT, customer_name TEXT,
    cloudflare_account_id TEXT, github_login TEXT, plan_json TEXT, status TEXT, created_at INTEGER,
    updated_at INTEGER, preview_html TEXT);
    CREATE TABLE onboarding_launch_jobs (id TEXT, github_user_id INTEGER, cloudflare_account_id TEXT,
    plan_json TEXT, status TEXT, expected_commit_sha TEXT, approved_html TEXT);`);
  return {sqlite, DB: {prepare: sql => ({bind: (...a) => ({
    first: async () => sqlite.prepare(sql).get(...a) || null,
    run: async () => sqlite.prepare(sql).run(...a)
  })})}};
}

function bridge() {
  const {db} = createMemoryD1();
  const tokens = new MemoryAgentTokenStore();
  const links = {getLink: async () => ({...owner}), async peekChallenge() { return null; }};
  const host = createBridgeHost({tokens, sites: new D1SiteDraftStore(db), nowSeconds: now,
    bridgeTicketKey: KEY, links: {...links, getLink: async () => ({...owner})}});
  // Owner-linked principal: linkedOwnerFromStore reads links.getLink.
  const token = tokens.issue({subject: 'sub_owner_1', clientId: 'mcpc_client_1', nowSeconds: now(),
    audience: BRIDGE_AUDIENCE});
  const call = async (name, args) => handleBridgeRequest(host, {method: 'POST', url: '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token}, body: {name, arguments: args}});
  // Onboarding reaches the bridge's internal route through this fetch.
  const fetchFn = async (url, init) => {
    const r = await handleBridgeRequest(host, {method: 'POST', url: new URL(url).pathname,
      headers: {}, body: JSON.parse(init.body)});
    return new Response(JSON.stringify(r.body), {status: r.status});
  };
  return {host, call, fetchFn};
}

const spec = {name: 'Willow Test Bakery', headline: 'Fresh bread daily',
  about: 'Small-batch loaves every morning.', services: ['Sourdough', 'Pastries'], theme: 'forest'};
const session = (extra = {}) => ({hash: 'sess_hash_1', github_user_id: 42, github_login: 'owner',
  cloudflare_account_id: ACCOUNT, cloudflare_token_ct: 'ct', ...extra});
const helpers = {
  redirect: path => new Response(null, {status: 302, headers: {location: path}}),
  fail: (msg, status = 400) => new Response(msg, {status}),
  now
};

test('agent draft becomes an exact onboarding preview, idempotently', async () => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const approval = (await b.call('request_explicit_approval', {draft_id: prepared.draft_id,
    preview_sha256: prepared.preview_sha256, idempotency_key: 'k'.repeat(20)})).body;
  assert.equal(approval.action_url, 'https://onboard.360web.cloud/review?draft=' + prepared.draft_id);
  const preview = (await b.call('get_exact_preview', {draft_id: prepared.draft_id})).body;
  assert.equal(preview.review_url, approval.action_url);

  const env = {...onboardingDb(), BRIDGE_TICKET_KEY: KEY, BRIDGE_ORIGIN: 'https://mcp.360web.cloud'};
  const res = await importBridgeDraft(env, session(), prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
  assert.equal(res.status, 302, await res.clone().text());
  const row = env.sqlite.prepare('SELECT * FROM onboarding_launches').get();
  assert.equal(res.headers.get('location'), '/review?id=' + row.id);
  assert.equal(row.status, 'preview');
  assert.equal(await sha256(row.preview_html), prepared.preview_sha256);
  assert.equal(JSON.parse(row.plan_json).bridgeDraftId, prepared.draft_id);

  const again = await importBridgeDraft(env, session(), prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
  assert.equal(again.headers.get('location'), '/review?id=' + row.id);
  assert.equal(env.sqlite.prepare('SELECT count(*) n FROM onboarding_launches').get().n, 1);
});

test('draft import fails closed for other accounts, unsigned sessions and forged ids', async () => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const env = {...onboardingDb(), BRIDGE_TICKET_KEY: KEY, BRIDGE_ORIGIN: 'https://mcp.360web.cloud'};
  const other = await importBridgeDraft(env, session({github_user_id: 43}), prepared.draft_id,
    {...helpers, fetchFn: b.fetchFn});
  assert.equal(other.status, 404);
  const otherCf = await importBridgeDraft(env, session({cloudflare_account_id: 'f'.repeat(32)}),
    prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
  assert.equal(otherCf.status, 404);
  assert.equal((await importBridgeDraft(env, session({cloudflare_token_ct: null}), prepared.draft_id,
    {...helpers, fetchFn: b.fetchFn})).status, 403);
  assert.equal((await importBridgeDraft(env, session(), 'draft_../../x', {...helpers, fetchFn: b.fetchFn})).status, 400);
  assert.equal(env.sqlite.prepare('SELECT count(*) n FROM onboarding_launches').get().n, 0);
  // A status ticket cannot be replayed as a draft ticket.
  const statusTicket = await mintOwnerTicket(KEY, 'status', {draftId: prepared.draft_id,
    githubUserId: 42, cloudflareAccountId: ACCOUNT, nowSeconds: now()});
  const replay = await handleBridgeRequest(b.host, {method: 'POST', url: '/mcp/internal/draft',
    headers: {}, body: {ticket: statusTicket}});
  assert.equal(replay.status, 400);
});

test('job status by draft id: draft → queued → live only with commit + HTML digests', async () => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const env = {...onboardingDb(), BRIDGE_TICKET_KEY: KEY, BRIDGE_ORIGIN: 'https://mcp.360web.cloud'};
  b.host.onboardingStatus = async ticket => (await bridgeLaunchStatus(new Request('https://x/',
    {method: 'POST', body: JSON.stringify({ticket})}), env, {now})).json();

  assert.deepEqual((await b.call('get_job_status', {job_id: prepared.draft_id})).body,
    {job_id: prepared.draft_id, state: 'draft'});
  const plan = JSON.stringify({bridgeDraftId: prepared.draft_id});
  env.sqlite.prepare(`INSERT INTO onboarding_launch_jobs VALUES ('j1',42,?,?,'queued',NULL,NULL)`).run(ACCOUNT, plan);
  assert.equal((await b.call('verify_publication', {job_id: prepared.draft_id})).body.state, 'queued');

  const html = '<!doctype html><p>approved</p>';
  env.sqlite.prepare(`UPDATE onboarding_launch_jobs SET status='live', expected_commit_sha=?, approved_html=?`)
    .run('a'.repeat(40), html);
  const live = (await b.call('verify_publication', {job_id: prepared.draft_id})).body;
  assert.deepEqual(live, {job_id: prepared.draft_id, state: 'live',
    production_commit_sha: 'a'.repeat(40), public_html_sha256: await sha256(html)});

  // A job owned by another Cloudflare account is never reported.
  env.sqlite.prepare(`UPDATE onboarding_launch_jobs SET cloudflare_account_id=?`).run('f'.repeat(32));
  assert.equal((await b.call('get_job_status', {job_id: prepared.draft_id})).body.state, 'draft');
  const bad = await bridgeLaunchStatus(new Request('https://x/', {method: 'POST',
    body: JSON.stringify({ticket: 'forged'})}), env, {now});
  assert.equal(bad.status, 400);
});
