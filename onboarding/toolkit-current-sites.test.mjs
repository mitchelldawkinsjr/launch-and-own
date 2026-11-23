import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOwnerAuthorizationFence, ownerPrincipalFromSession, renderCurrentSitesSection, loadCurrentManagedSitesPage
} from './toolkit-current-sites.mjs';
import {
  accountId, approvePreview, connectTenant, harness, makeDue, newPreview, post
} from './worker-test-support.mjs';

test('owner principal requires both providers and a selected Cloudflare account', () => {
  assert.equal(ownerPrincipalFromSession(null), null);
  assert.equal(ownerPrincipalFromSession({
    github_user_id: 1, github_login: 'tester'
  }), null);
  assert.deepEqual(ownerPrincipalFromSession({
    github_user_id: 17, github_login: 'tester', cloudflare_account_id: accountId
  }), {
    githubUserId: 17, githubLogin: 'tester', cloudflareAccountId: accountId
  });
});

test('inventory fences retain the selected epoch and use the current time on each check', async () => {
  const session = {hash: 'session-hash', authorization_epoch: 8,
    github_user_id: 17, github_login: 'tester', cloudflare_account_id: accountId};
  const observed = [];
  const env = {DB: {prepare: () => ({bind: (...values) => ({first: async () => {
    observed.push(values);
    return {present:1};
  }})})}};
  let now = 100;
  const principal = ownerPrincipalFromSession(session);
  const authorize = createOwnerAuthorizationFence(env, session, () => now);
  assert.equal(await authorize(principal), true);
  now += 10;
  session.authorization_epoch = 9;
  assert.equal(await authorize(principal), true);
  assert.deepEqual(observed, [
    ['session-hash', 8, 17, accountId, 100], ['session-hash', 8, 17, accountId, 110]
  ]);
});

test('current sites HTML never invents a live website link', () => {
  const html = renderCurrentSitesSection({
    status: 'ok', page: 1, nextPage: null, sites: [{
      siteId: 'managed_101_pages-stable-101',
      repositoryName: 'esp-willow-studio',
      repositoryUrl: 'https://github.com/tester/esp-willow-studio',
      pagesProjectDashboardUrl: 'https://dash.cloudflare.com/' + accountId +
        '/pages/view/esp-willow-studio-site',
      baseCommitSha: 'a'.repeat(40),
      productionCommitSha: 'a'.repeat(40),
      publicationVerified: false
    }]
  }, {escape: s => String(s)});
  assert.match(html, /Publication unverified/);
  assert.match(html, /Open GitHub repository/);
  assert.match(html, /Open Cloudflare dashboard/);
  assert.doesNotMatch(html, /href="https:\/\/esp-willow-studio-site\.pages\.dev/);
  assert.doesNotMatch(html, /Verified live/i);
});

test('GET /toolkit soft-loads current managed sites without provider writes', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  t.mock.method(globalThis, 'fetch', h.fetchFn);
  h.resourceState.issueExpiringGrants = true;
  const tenant = await connectTenant(h);
  const id = await newPreview(h, tenant);
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/launch', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);

  const writesBefore = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' ||
    c.method === 'DELETE'
  ).length;
  const page = await h.request('/toolkit', {cookie: tenant.cookie});
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Current managed sites/);
  assert.match(html, /Publication unverified/);
  assert.match(html, /Open GitHub repository/);
  assert.match(html, /Open Cloudflare dashboard/);
  assert.doesNotMatch(html, /href="https:\/\/esp-willow-studio-site\.pages\.dev/);
  const writesAfter = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' ||
    c.method === 'DELETE'
  ).length;
  assert.equal(writesAfter, writesBefore);

  const inventoryGets = h.calls.filter(c =>
    c.method === 'GET' &&
    (c.url.includes('/pages/projects') || c.url.includes('api.github.com'))
  );
  assert.ok(inventoryGets.length >= 1);

  h.sqlite.prepare('UPDATE onboarding_sessions SET github_token_expires_at = 0').run();
  const refreshCount = () => h.calls.filter(call => call.method === 'POST' &&
    call.url === 'https://github.com/login/oauth/access_token').length;
  const beforeRefresh = refreshCount();
  const refreshed = await h.request('/toolkit', {cookie: tenant.cookie});
  assert.equal(refreshed.status, 200);
  assert.match(await refreshed.text(), /Open GitHub repository/);
  assert.equal(refreshCount(), beforeRefresh + 1);

  h.resourceState.invalidateSessionOnRepoRead = true;
  const revoked = await h.request('/toolkit', {cookie: tenant.cookie});
  assert.equal(revoked.status, 401);
  assert.doesNotMatch(await revoked.text(), /Willow Studio|Open GitHub repository/);
});

test('loadCurrentManagedSitesPage fails closed when the owner session is missing an account', async () => {
  const result = await loadCurrentManagedSitesPage({}, {
    github_user_id: 1, github_login: 'tester'
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'verified_owner_required');
});
