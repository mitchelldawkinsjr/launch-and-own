import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  createOwnerAuthorizationFence, ownerPrincipalFromSession, renderCurrentSitesSection, loadCurrentManagedSitesPage,
  sealManagedSiteReference, openManagedSiteReference, inspectSealedManagedSource,
  renderCurrentSourcePage
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
      publicationVerified: false,
      sourceTicket: 'sealed-ticket-fixture'
    }]
  }, {escape: s => String(s)});
  assert.match(html, /Publication unverified/);
  assert.match(html, /Open GitHub repository/);
  assert.match(html, /Open Cloudflare dashboard/);
  assert.match(html, /\/toolkit\/source\?ticket=sealed-ticket-fixture/);
  assert.doesNotMatch(html, /href="https:\/\/esp-willow-studio-site\.pages\.dev/);
  assert.doesNotMatch(html, /Verified live/i);
});

test('sealed managed-site tickets bind session epoch and reject forgery', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  t.mock.method(globalThis, 'fetch', h.fetchFn);
  const tenant = await connectTenant(h);
  const session = {
    hash: h.sqlite.prepare('SELECT id_hash AS hash, authorization_epoch, github_user_id, github_login, cloudflare_account_id FROM onboarding_sessions').get().hash,
    authorization_epoch: 0,
    github_user_id: h.resourceState.githubUserId,
    github_login: 'tester',
    cloudflare_account_id: accountId
  };
  const row = h.sqlite.prepare(
    'SELECT id_hash AS hash, authorization_epoch FROM onboarding_sessions'
  ).get();
  session.hash = row.hash;
  session.authorization_epoch = row.authorization_epoch;

  const site = {
    siteId: 'managed_101_pages-stable-101',
    githubUserId: session.github_user_id,
    githubOwner: 'tester',
    cloudflareAccountId: accountId,
    repositoryId: 101,
    repositoryName: 'esp-willow-studio',
    pagesProjectId: 'pages-stable-101',
    pagesProjectName: 'esp-willow-studio-site',
    branch: 'main',
    productionBranch: 'main',
    sourceKind: 'managed-existing'
  };
  const ticket = await sealManagedSiteReference(h.env, session, site);
  const opened = await openManagedSiteReference(h.env, session, ticket);
  assert.equal(opened.siteId, site.siteId);

  await assert.rejects(
    () => openManagedSiteReference(h.env, session, ticket.slice(0, 12) + 'AAAA' + ticket.slice(16)),
    e => e.code === 'owned_site_not_found'
  );
  await assert.rejects(
    () => openManagedSiteReference(h.env, {
      ...session, authorization_epoch: session.authorization_epoch + 1
    }, ticket),
    e => e.code === 'owned_site_not_found'
  );
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
  assert.match(html, /\/toolkit\/source\?ticket=/);
  assert.doesNotMatch(html, /href="https:\/\/esp-willow-studio-site\.pages\.dev/);
  const writesAfter = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' ||
    c.method === 'DELETE'
  ).length;
  assert.equal(writesAfter, writesBefore);

  const ticket = new URL('https://onboard.example.com' +
    html.match(/href="(\/toolkit\/source\?ticket=[^"]+)"/)[1]).searchParams.get('ticket');
  const source = await h.request('/toolkit/source?ticket=' + encodeURIComponent(ticket), {
    cookie: tenant.cookie
  });
  assert.equal(source.status, 200);
  const sourceHtml = await source.text();
  assert.match(sourceHtml, /Homepage SHA-256/);
  assert.match(sourceHtml, /approved_migration_required/);
  assert.doesNotMatch(sourceHtml, /Willow Studio/);
  const row = h.sqlite.prepare(`SELECT id_hash AS hash, authorization_epoch, github_user_id,
    github_login, cloudflare_account_id, github_token_ct, cloudflare_token_ct
    FROM onboarding_sessions`).get();
  const inspected = await inspectSealedManagedSource(h.env, row, ticket, {fetchFn: h.fetchFn,
    githubAccessToken:'fixture-github',cloudflareAccessToken:'fixture-cloudflare'});
  assert.equal(inspected.status, 'ok');
  assert.equal(Object.hasOwn(inspected, 'html'), false);
  const expected = createHash('sha256')
    .update(h.resourceState.homepageHtml, 'utf8').digest('hex');
  assert.equal(inspected.homepageHtmlSha256, expected);
  assert.match(sourceHtml, new RegExp(expected));

  const forged = await h.request('/toolkit/source?ticket=not-a-real-ticket', {
    cookie: tenant.cookie
  });
  assert.equal(forged.status, 200);
  assert.match(await forged.text(), /unavailable or expired/);

  const refreshCount = () => h.calls.filter(call => call.method === 'POST' &&
    call.url === 'https://github.com/login/oauth/access_token').length;
  const beforeRefresh = refreshCount();
  h.sqlite.prepare('UPDATE onboarding_sessions SET github_token_expires_at = 0').run();
  const refreshed = await h.request('/toolkit', {cookie: tenant.cookie});
  assert.equal(refreshed.status, 200);
  assert.match(await refreshed.text(), /Open GitHub repository/);
  assert.equal(refreshCount(), beforeRefresh + 1);
  h.sqlite.prepare('UPDATE onboarding_sessions SET github_token_expires_at = 0').run();
  const refreshedSource = await h.request('/toolkit/source?ticket=' + encodeURIComponent(ticket), {cookie: tenant.cookie});
  assert.match(await refreshedSource.text(), /Homepage SHA-256/);
  assert.equal(refreshCount(), beforeRefresh + 2);

  h.resourceState.invalidateSessionOnRepoRead = true;
  const revoked = await h.request('/toolkit', {cookie: tenant.cookie});
  assert.equal(revoked.status, 401);
  assert.doesNotMatch(await revoked.text(), /Willow Studio|Open GitHub repository/);
});

test('source inspection page never embeds raw homepage HTML', () => {
  const meta = renderCurrentSourcePage({
    status: 'ok',
    siteId: 'managed_101_pages-stable-101',
    baseCommitSha: 'a'.repeat(40),
    homepageHtmlSha256: 'b'.repeat(64),
    homepageGitBlobSha: 'c'.repeat(40),
    publicationVerified: false,
    historicalContinuityVerified: false,
    editMode: 'approved_migration_required',
    html: '<script>alert(1)</script>'
  }, {view: (title, body) => title + '\n' + body, escape: s => String(s)});
  assert.doesNotMatch(meta, /<script>alert/);
  assert.match(meta, /approved_migration_required/);
});

test('loadCurrentManagedSitesPage fails closed when the owner session is missing an account', async () => {
  const result = await loadCurrentManagedSitesPage({}, {
    github_user_id: 1, github_login: 'tester'
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'verified_owner_required');
});
