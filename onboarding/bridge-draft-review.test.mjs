import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeLaunchStatus, importBridgeDraft} from './bridge-draft-review.mjs';
import {createMemoryD1} from '../integration/d1-support.mjs';
import {D1SiteDraftStore} from '../integration/d1-site-draft-store.mjs';
import {createBridgeHost, handleBridgeRequest, MemoryAgentTokenStore} from '../integration/bridge-transport.mjs';
import {mintOwnerTicket} from '../integration/draft-handoff.mjs';
import {BRIDGE_AUDIENCE} from '../integration/tool-contract.mjs';
import {sha256} from './crypto.mjs';
import {harness} from './worker-test-support.mjs';

const KEY = 'ef'.repeat(32);
const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const now = () => Math.floor(Date.now() / 1000);
const owner = {githubUserId: 42, cloudflareAccountId: ACCOUNT, authorizationEpoch: 0, reauthorized: true};

function onboardingDb(t) {
  const {sqlite, env} = harness();
  t.after(() => sqlite.close());
  const config = {...env, sqlite, BRIDGE_TICKET_KEY: KEY, BRIDGE_ORIGIN: 'https://mcp.360web.cloud'};
  saveSession(config, session());
  return config;
}

function saveSession(env, current) {
  env.sqlite.prepare(`INSERT INTO onboarding_sessions(id_hash, github_user_id, github_login,
    github_token_ct, cloudflare_token_ct, cloudflare_account_id, csrf_ct, created_at, expires_at,
    authorization_epoch) VALUES (?, ?, ?, 'gh_ct', ?, ?, 'csrf_ct', ?, ?, ?)`)
    .run(current.hash, current.github_user_id, current.github_login, current.cloudflare_token_ct,
      current.cloudflare_account_id, now(), now() + 3600, current.authorization_epoch);
}

function bridge() {
  const {db} = createMemoryD1();
  const tokens = new MemoryAgentTokenStore();
  const link = {...owner};
  const links = {getLink: async () => ({...link}), async peekChallenge() { return null; }};
  const host = createBridgeHost({tokens, sites: new D1SiteDraftStore(db), nowSeconds: now,
    bridgeTicketKey: KEY, links});
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
  return {host, call, fetchFn, link};
}

const spec = {name: 'Willow Test Bakery', headline: 'Fresh bread daily',
  about: 'Small-batch loaves every morning.', services: ['Sourdough', 'Pastries'], theme: 'forest'};
const session = (extra = {}) => ({hash: 'sess_hash_1', github_user_id: 42, github_login: 'owner',
  cloudflare_account_id: ACCOUNT, cloudflare_token_ct: 'ct', authorization_epoch: 0, ...extra});
const helpers = {
  redirect: path => new Response(null, {status: 302, headers: {location: path}}),
  fail: (msg, status = 400) => new Response(msg, {status}),
  now
};

test('concurrent agent draft imports stage one exact onboarding preview', async t => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const approval = (await b.call('request_explicit_approval', {draft_id: prepared.draft_id,
    preview_sha256: prepared.preview_sha256, idempotency_key: 'k'.repeat(20)})).body;
  assert.equal(approval.action_url, 'https://onboard.360web.cloud/review?draft=' + prepared.draft_id);
  const preview = (await b.call('get_exact_preview', {draft_id: prepared.draft_id})).body;
  assert.equal(preview.review_url, approval.action_url);

  const env = onboardingDb(t);
  let fetched = 0;
  const fetchDraft = async (...args) => {
    fetched++;
    return b.fetchFn(...args);
  };
  const [res, overlap] = await Promise.all([1, 2].map(() =>
    importBridgeDraft(env, session(), prepared.draft_id, {...helpers, fetchFn: fetchDraft})));
  assert.equal(res.status, 302, await res.clone().text());
  assert.equal(fetched, 2);
  const row = env.sqlite.prepare('SELECT * FROM onboarding_launches').get();
  assert.equal(res.headers.get('location'), '/review?id=' + row.id);
  assert.equal(overlap.headers.get('location'), res.headers.get('location'));
  assert.equal(row.status, 'preview');
  assert.equal(await sha256(row.preview_html), prepared.preview_sha256);
  assert.equal(JSON.parse(row.plan_json).bridgeDraftId, prepared.draft_id);

  const again = await importBridgeDraft(env, session(), prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
  assert.equal(again.headers.get('location'), '/review?id=' + row.id);
  assert.equal(env.sqlite.prepare('SELECT count(*) n FROM onboarding_launches').get().n, 1);

  env.sqlite.prepare('UPDATE onboarding_sessions SET authorization_epoch = authorization_epoch + 1').run();
  const stale = await importBridgeDraft(env, session(), prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
  assert.equal(stale.status, 403);
  assert.equal(stale.headers.has('location'), false);
});

test('draft import fails closed for other accounts, unsigned sessions and forged ids', async t => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const env = onboardingDb(t);
  const otherOwner = session({hash: 'sess_hash_2', github_user_id: 43});
  const otherAccount = session({hash: 'sess_hash_3', cloudflare_account_id: 'f'.repeat(32)});
  saveSession(env, otherOwner);
  saveSession(env, otherAccount);
  const other = await importBridgeDraft(env, otherOwner, prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
  assert.equal(other.status, 404);
  const otherCf = await importBridgeDraft(env, otherAccount, prepared.draft_id, {...helpers, fetchFn: b.fetchFn});
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

test('a session change while fetching the bridge draft prevents staging', async t => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const env = onboardingDb(t);
  const fetchFn = async (...args) => {
    const response = await b.fetchFn(...args);
    env.sqlite.prepare(`UPDATE onboarding_sessions SET cloudflare_account_id = ?,
      authorization_epoch = authorization_epoch + 1`).run('f'.repeat(32));
    return response;
  };
  const response = await importBridgeDraft(env, session(), prepared.draft_id, {...helpers, fetchFn});
  assert.equal(response.status, 403);
  assert.equal(response.headers.has('location'), false);
  assert.equal(env.sqlite.prepare('SELECT count(*) n FROM onboarding_launches').get().n, 0);
});

function statusRequest(env, body, origin = env.ONBOARDING_ORIGIN) {
  return new Request(origin + '/internal/bridge-launch-status', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
  });
}

test('draft status requires a current owner and reports the previous verified publication', async t => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  const env = onboardingDb(t);
  b.host.onboardingStatus = async ticket => (await bridgeLaunchStatus(statusRequest(env, {ticket}), env, {now})).json();

  assert.deepEqual((await b.call('get_job_status', {job_id: prepared.draft_id})).body,
    {job_id: prepared.draft_id, state: 'draft'});
  const plan = JSON.stringify({bridgeDraftId: prepared.draft_id});
  const time = now();
  const html = '<!doctype html><p>approved</p>';
  env.sqlite.prepare(`INSERT INTO onboarding_launch_jobs(id, github_user_id, github_login, cloudflare_account_id,
    customer_name, site_slug, plan_json, approved_html, approval_digest, status, approved_at, updated_at,
    expires_at, next_attempt_at) VALUES ('j1', 42, 'owner', ?, 'Willow Test Bakery', 'willow-test', ?, ?, ?,
      'queued', ?, ?, ?, ?)`).run(ACCOUNT, plan, html, 'b'.repeat(64), time, time, time + 6000, time);
  env.sqlite.prepare(`INSERT INTO onboarding_launch_job_sessions(job_id, session_hash, authorization_epoch)
    VALUES ('j1', ?, 0)`).run(session().hash);
  assert.equal((await b.call('verify_publication', {job_id: prepared.draft_id})).body.state, 'queued');

  env.sqlite.prepare(`UPDATE onboarding_launch_jobs SET status='live', repository_id=1,
    production_branch='main', expected_commit_sha=?, pages_project_id='pages_id', provisioned_at=?`)
    .run('a'.repeat(40), time);
  const verified = (await b.call('verify_publication', {job_id: prepared.draft_id})).body;
  assert.deepEqual(verified, {job_id: prepared.draft_id, state: 'last_verified', last_verified_at: time,
    last_verified_commit_sha: 'a'.repeat(40), last_verified_html_sha256: await sha256(html)});

  env.sqlite.prepare(`UPDATE onboarding_sessions SET expires_at=?`).run(time);
  assert.deepEqual((await b.call('get_job_status', {job_id: prepared.draft_id})).body,
    {job_id: prepared.draft_id, state: 'needs_reauthorization'});

  env.sqlite.prepare(`UPDATE onboarding_sessions SET expires_at=?`).run(time + 3600);
  env.sqlite.prepare(`UPDATE onboarding_launch_jobs SET expires_at=?`).run(time);
  assert.equal((await b.call('get_job_status', {job_id: prepared.draft_id})).body.state, 'draft');

  // A job owned by another Cloudflare account is never reported.
  env.sqlite.prepare(`UPDATE onboarding_launch_jobs SET cloudflare_account_id=?, expires_at=?`)
    .run('f'.repeat(32), time + 6000);
  assert.equal((await b.call('get_job_status', {job_id: prepared.draft_id})).body.state, 'draft');
});

test('internal status rejects untrusted hosts, oversized request bodies and invalid tickets', async t => {
  const env = onboardingDb(t);
  const wrongHost = await bridgeLaunchStatus(statusRequest(env, {ticket: 'forged'}, 'https://elsewhere.com'), env, {now});
  assert.equal(wrongHost.status, 404);
  const oversized = await bridgeLaunchStatus(statusRequest(env, {ticket: 'a'.repeat(4096)}), env, {now});
  assert.equal(oversized.status, 413);
  const bad = await bridgeLaunchStatus(statusRequest(env, {ticket: 'forged'}), env, {now});
  assert.equal(bad.status, 400);
});

test('bridge discards draft status after a link change or an older status response', async () => {
  const b = bridge();
  const prepared = (await b.call('prepare_site', {site_spec: spec})).body;
  b.host.onboardingStatus = async () => ({status: 'live', production_commit_sha: 'a'.repeat(40),
    approved_html_sha256: 'b'.repeat(64)});
  const old = await b.call('verify_publication', {job_id: prepared.draft_id});
  assert.equal(old.body.error, 'onboarding_status_unavailable');

  b.host.onboardingStatus = async () => {
    b.link.authorizationEpoch++;
    return {handoff_version: 2, status: 'last_verified', last_verified_at: now(),
      last_verified_commit_sha: 'a'.repeat(40), last_verified_html_sha256: 'b'.repeat(64)};
  };
  const changed = await b.call('get_job_status', {job_id: prepared.draft_id});
  assert.equal(changed.status, 404);
  assert.deepEqual(changed.body, {error: 'not_found'});
});
