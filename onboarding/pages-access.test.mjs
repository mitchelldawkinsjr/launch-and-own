import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';
import {pagesAccessFetch, PagesAccessChanged} from './pages-access.mjs';
import {
  accountId, bootstrap, connectCloudflare, connectTenant, csrfFrom, harness, jobRow,
  newPreview, originalFetch, post, reviewDigest, writes
} from './worker-test-support.mjs';

const token = 'fixture_cloudflare_pages_access_token';
const alternateToken = token + '_replacement';
const path = '/cloudflare-pages-access';
const projectList = 'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/pages/projects';

function setup(t) {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  t.after(() => { globalThis.fetch = originalFetch; h.sqlite.close(); });
  h.resourceState.pagesAccessToken = token;
  return h;
}

const accessRow = h => h.sqlite.prepare('SELECT * FROM onboarding_pages_access').get();
const approveWithAccess = async (h, tenant, id, accessId = accessRow(h)?.access_id, options) =>
  post(h, '/approve', tenant.cookie, {csrf: tenant.csrf, id,
    digest: await reviewDigest(h, tenant.cookie, id), pagesAccessId: accessId}, options);

test('an independently owned account can launch with Pages Edit after OAuth Pages denial', async t => {
  const h = setup(t);
  h.resourceState.denyPagesOAuth = true;
  const {sessionCookie: cookie} = await bootstrap(h);
  await connectCloudflare(h, cookie);
  const csrf = csrfFrom(await (await h.request('/', {cookie})).text());
  const selection = await post(h, '/account', cookie, {csrf, accountId});
  assert.equal(selection.status, 303);
  assert.equal(selection.headers.get('location'), path);
  assert.equal(h.sqlite.prepare('SELECT cloudflare_account_id FROM onboarding_sessions').get().cloudflare_account_id,
    accountId);
  assert.equal(writes(h).length, 0);

  const accessPage = await (await h.request(path, {cookie})).text();
  assert.match(accessPage, /Cloudflare Pages → Read/);
  assert.match(accessPage, /type="password"/);
  assert.match(await (await h.request('/toolkit', {cookie})).text(), /Connect Cloudflare Pages access/);
  const denied = await post(h, path, cookie, {csrf, token: alternateToken, mode: 'edit'});
  assert.equal(denied.status, 400);
  const failure = await denied.text();
  assert.match(failure, /cloudflare_pages_http_401_cf10000/);
  assert.ok(!failure.includes(alternateToken));
  assert.equal(accessRow(h), undefined);
  assert.equal((await post(h, path, cookie, {csrf, token, mode: 'edit'})).status, 303);
  assert.equal(accessRow(h).mode, 'edit');
  assert.ok(!accessRow(h).token_ct.includes(token));
  assert.ok(!((await (await h.request(path, {cookie})).text()).includes(token)));
  const tenant = {cookie, csrf};
  const id = await newPreview(h, tenant);
  assert.equal((await approveWithAccess(h, tenant, id)).status, 303);
  assert.equal(jobRow(h).status, 'pending_deployment');
  assert.equal(jobRow(h).pages_project_id, 'pages-stable-101');
  assert.equal(h.resourceState.pages.source.config.preview_deployment_setting, 'none');
  assert.equal((await post(h, '/verify', cookie, {csrf, id})).status, 303);
  assert.equal(jobRow(h).status, 'live');
});

test('read-only Pages access is fenced to the selected account and credential version', async t => {
  const h = setup(t);
  const tenant = await connectTenant(h);
  const unprovisioned = await newPreview(h, tenant);
  const digest = await reviewDigest(h, tenant.cookie, unprovisioned);
  assert.equal((await post(h, path, tenant.cookie, {csrf: 'wrong', token, mode: 'read'})).status, 400);
  assert.equal(accessRow(h), undefined);
  assert.equal((await post(h, path, tenant.cookie, {csrf: tenant.csrf, token, mode: 'read'})).status, 303);
  const session = h.sqlite.prepare('SELECT *, id_hash AS hash FROM onboarding_sessions').get();
  const forwarded = [];
  const access = await pagesAccessFetch(h.env, session, async (url, init) => {
    forwarded.push({url, method: init.method, bearer: new Headers(init.headers).get('authorization')});
  }, {allowWrite: true});
  await access.fetchFn(projectList, {headers: {authorization: 'Bearer oauth-fixture'}});
  await access.fetchFn(projectList.replace(accountId, 'f'.repeat(32)), {headers: {authorization: 'Bearer oauth-fixture'}});
  await access.fetchFn('https://esp-willow-studio-site.pages.dev/');
  assert.deepEqual(forwarded.map(request => request.bearer), ['Bearer ' + token, 'Bearer oauth-fixture', null]);
  await assert.rejects(access.fetchFn(projectList, {method: 'POST'}), /outside the connected access/);
  await assert.rejects(access.fetchFn(projectList + '/esp-willow-studio-site', {method: 'DELETE'}),
    /outside the connected access/);
  assert.equal(forwarded.length, 3);
  assert.doesNotMatch(await (await h.request('/review?id=' + unprovisioned, {cookie: tenant.cookie})).text(), /Approve and create website/);
  const denied = await post(h, '/approve', tenant.cookie, {csrf: tenant.csrf, id: unprovisioned, digest,
    pagesAccessId: accessRow(h).access_id});
  assert.equal(denied.status, 403);
  assert.equal(writes(h).length, 0);

  assert.equal((await post(h, '/account', tenant.cookie, {csrf: tenant.csrf, accountId: 'f'.repeat(32)})).status, 303);
  assert.equal(accessRow(h), undefined);
  await assert.rejects(access.fetchFn(projectList), PagesAccessChanged);
});

test('changing Pages credentials rejects stale approval and fences a queued launch', async t => {
  const h = setup(t);
  const tenant = await connectTenant(h);
  const connect = token => post(h, path, tenant.cookie, {csrf: tenant.csrf, token, mode: 'edit'});
  assert.equal((await connect(token)).status, 303);
  const original = accessRow(h).access_id;
  const id = await newPreview(h, tenant);
  assert.match(await (await h.request('/review?id=' + id, {cookie: tenant.cookie})).text(), new RegExp(original));
  h.resourceState.pagesAccessToken = alternateToken;
  assert.equal((await connect(alternateToken)).status, 303);
  assert.equal((await approveWithAccess(h, tenant, id, original)).status, 409);
  assert.equal(jobRow(h), undefined);
  const updated = accessRow(h).access_id;
  assert.equal((await approveWithAccess(h, tenant, id, updated, {skipFastPath: true})).status, 303);
  assert.equal(jobRow(h).status, 'queued');
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS matching FROM onboarding_launch_job_sessions a
    JOIN onboarding_sessions s ON s.id_hash = a.session_hash AND s.authorization_epoch = a.authorization_epoch`)
    .get().matching, 0, 'an older Worker cannot treat this as an OAuth approval');
  assert.equal((await post(h, path + '/remove', tenant.cookie, {csrf: tenant.csrf, accessId: updated})).status, 303);
  assert.equal(accessRow(h), undefined);
  await worker.scheduled({}, h.env);
  assert.equal(jobRow(h).status, 'needs_reauthorization');
  assert.equal(writes(h).length, 0);
});
