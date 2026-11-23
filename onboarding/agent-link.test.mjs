import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId, bootstrap, connectCloudflare, connectTenant, csrfFrom, form,
  harness, origin, post
} from './worker-test-support.mjs';
import {mintBrowserLinkTicket, openBrowserLinkTicket} from '../integration/browser-link-ticket.mjs';

const challengeId = 'link_' + 'ab'.repeat(12);
const ticketKey = 'cd'.repeat(32);
const bridgeOrigin = 'https://bridge.test.example';

test('agent-link requires signed-in Cloudflare account before confirming', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  const missing = await h.request('/agent-link?challenge_id=' + challengeId);
  assert.equal(missing.status, 200);
  assert.match(await missing.text(), /Connect GitHub/);

  const {sessionCookie} = await bootstrap(h);
  const ghOnly = await h.request('/agent-link?challenge_id=' + challengeId, {
    cookie: sessionCookie
  });
  assert.match(await ghOnly.text(), /Connect Cloudflare/);

  await connectCloudflare(h, sessionCookie);
  const noAccount = await h.request('/agent-link?challenge_id=' + challengeId, {
    cookie: sessionCookie
  });
  assert.match(await noAccount.text(), /Choose Cloudflare account/);
});

test('agent-link mints a sealed ticket from session ids and posts to bridge', async () => {
  const h = harness();
  h.env.BRIDGE_TICKET_KEY = ticketKey;
  h.env.BRIDGE_ORIGIN = bridgeOrigin;
  let seen;
  const prior = h.fetchFn;
  h.fetchFn = async (url, opts = {}) => {
    if (String(url) === bridgeOrigin + '/mcp/link/browser') {
      seen = {url, opts};
      const body = JSON.parse(opts.body);
      const opened = await openBrowserLinkTicket(ticketKey, body.ticket, {
        nowSeconds: Math.floor(Date.now() / 1000)
      });
      assert.equal(opened.challengeId, challengeId);
      assert.equal(opened.githubUserId, 42);
      assert.equal(opened.cloudflareAccountId, accountId);
      assert.equal(body.verified, undefined);
      return Response.json({
        linked: true,
        github_user_id: opened.githubUserId,
        cloudflare_account_id: opened.cloudflareAccountId,
        authorization_epoch: 0
      });
    }
    return prior(url, opts);
  };
  globalThis.fetch = h.fetchFn;

  const {cookie, csrf} = await connectTenant(h);
  const page = await h.request('/agent-link?challenge_id=' + challengeId, {cookie});
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Confirm and link agent/);

  const confirmed = await post(h, '/agent-link', cookie, {csrf, challenge_id: challengeId});
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /Agent linked/);
  assert.equal(seen.url, bridgeOrigin + '/mcp/link/browser');
  assert.match(seen.opts.headers['content-type'], /application\/json/);
});

test('agent-link fails closed without bridge config or with bad CSRF', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  const {cookie, csrf} = await connectTenant(h);
  const unconfigured = await h.request('/agent-link?challenge_id=' + challengeId, {cookie});
  assert.match(await unconfigured.text(), /not configured/);

  h.env.BRIDGE_TICKET_KEY = ticketKey;
  h.env.BRIDGE_ORIGIN = bridgeOrigin;
  const bad = await post(h, '/agent-link', cookie, {
    csrf: 'deadbeef', challenge_id: challengeId
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await mintBrowserLinkTicket(ticketKey, {
      challengeId,
      githubUserId: 42,
      cloudflareAccountId: accountId,
      nowSeconds: 1_700_000_000
    })).length > 20,
    true
  );
  assert.ok(csrf);
});
