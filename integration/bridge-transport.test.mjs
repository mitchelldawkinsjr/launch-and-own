import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBridgeHost, handleBridgeRequest, MemoryAgentTokenStore
} from './bridge-transport.mjs';
import {MemoryOwnerLinkStore, linkedOwnerFromStore} from './owner-link-store.mjs';
import {
  RESOURCE_METADATA_PATH, RESOURCE_URI, protectedResourceMetadata
} from './protected-resource.mjs';
import {BRIDGE_AUDIENCE, BridgeContractError} from './tool-contract.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const otherAccount = 'abcdef0123456789abcdef012345678a';
let now = 1_700_000_000;
const host = () => createBridgeHost({
  tokens: new MemoryAgentTokenStore(),
  links: new MemoryOwnerLinkStore(),
  nowSeconds: () => now
});

function issue(h, overrides = {}) {
  return h.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    nowSeconds: now, ...overrides
  });
}

const ORIGIN = 'https://onboard.360web.cloud';

async function toolCall(h, token, name, args = {}) {
  return await handleBridgeRequest(h, {
    method: 'POST',
    url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name, arguments: args}
  });
}

async function complete(h, token, challengeId, verified) {
  const session = h.tokens.lookup(token, {nowSeconds: now});
  if (!session) return {status: 401, body: {error: 'unauthenticated'}};
  const principal = {
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: session.subject, clientId: session.clientId,
    expiresAt: session.expiresAt,
    linkedOwner: await linkedOwnerFromStore(h.links, session.subject, session.clientId)
  };
  try {
    const record = await h.links.consumeLinkChallenge({
      challengeId, verifiedIdentity: verified, principal, nowSeconds: now
    });
    return {status: 200, body: {
      linked: true, github_user_id: record.githubUserId,
      cloudflare_account_id: record.cloudflareAccountId,
      authorization_epoch: record.authorizationEpoch
    }};
  } catch (error) {
    if (!(error instanceof BridgeContractError)) throw error;
    return {status: 400, body: {error: error.code}};
  }
}

async function untrustedHttpComplete(h, token, challengeId, verified) {
  return await handleBridgeRequest(h, {
    method: 'POST',
    url: ORIGIN + '/mcp/link/complete',
    headers: {authorization: 'Bearer ' + token},
    body: {challenge_id: challengeId, verified}
  });
}

test('protected resource metadata advertises provisional bridge markers', async () => {
  const meta = protectedResourceMetadata();
  assert.equal(meta.resource, RESOURCE_URI);
  assert.equal(meta.launch_and_own.bridge_audience, BRIDGE_AUDIENCE);
  assert.equal(meta.launch_and_own.status, 'not_deployed');
  const h = host();
  const res = await handleBridgeRequest(h, {
    method: 'GET', url: 'https://onboard.360web.cloud' + RESOURCE_METADATA_PATH
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.resource, RESOURCE_URI);
});

test('missing/wrong/expired bearer fails closed at the transport edge', async () => {
  const h = host();
  const token = issue(h);
  assert.equal((await toolCall(h, 'not-a-token', 'get_connection_status')).body.error, 'unauthenticated');
  assert.equal((await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {}, body: {name: 'get_connection_status', arguments: {}}
  })).status, 401);
  now += 10_000;
  assert.equal((await toolCall(h, token, 'get_connection_status')).body.error, 'unauthenticated');
  now = 1_700_000_000;
});

test('model cannot inject owner identity through tool payload fields', async () => {
  const h = host();
  const token = issue(h);
  assert.equal((await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {
      name: 'get_connection_status', arguments: {},
      linkedOwner: {githubUserId: 999, cloudflareAccountId: otherAccount}
    }
  })).body.error, 'invalid_arguments');
  assert.equal((await toolCall(h, token, 'list_sites', {
    owner_id: 'someone_else'
  })).body.error, 'invalid_arguments');
});

test('first-time browser link binds providers; reconnect requires pinned IDs', async () => {
  const h = host();
  const token = issue(h);
  const status0 = await toolCall(h, token, 'get_connection_status');
  assert.equal(status0.status, 200);
  assert.equal(status0.body.linked, false);

  const start = await toolCall(h, token, 'start_connect_accounts');
  assert.equal(start.status, 200);
  assert.equal(start.body.state, 'needs_browser_link');
  assert.equal(start.body.action_url, 'https://onboard.360web.cloud/');
  assert.equal(start.body.expectedGithubUserId, undefined);
  assert.equal(start.body.oauth_state, undefined);

  const linked = await complete(h, token, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.linked, true);
  assert.equal(linked.body.authorization_epoch, 0);

  // Replay of the same challenge fails closed.
  assert.equal((await complete(h, token, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  })).body.error, 'invalid_link_challenge');

  const status1 = await toolCall(h, token, 'get_connection_status');
  assert.equal(status1.body.linked, true);
  assert.equal(status1.body.github_user_id, 123);

  // Reconnect with matching pins succeeds and bumps epoch.
  const reconnect = await toolCall(h, token, 'start_connect_accounts');
  const again = await complete(h, token, reconnect.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(again.body.authorization_epoch, 1);

  // Different verified Cloudflare account fails closed.
  const bad = await toolCall(h, token, 'start_connect_accounts');
  assert.equal((await complete(h, token, bad.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: otherAccount
  })).body.error, 'invalid_link_challenge');
});

test('linked tools stay gated until linked; inventory is empty until sites exist', async () => {
  const h = host();
  const token = issue(h);
  assert.equal((await toolCall(h, token, 'list_sites')).body.error, 'needs_reauthorization');

  const start = await toolCall(h, token, 'start_connect_accounts');
  await complete(h, token, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  const listed = await toolCall(h, token, 'list_sites');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sites, []);
  assert.equal((await toolCall(h, token, 'get_job_status', {job_id: 'job_12345'})).body.error,
    'not_found');
});

test('wrong client cannot consume another client challenge', async () => {
  const h = host();
  const tokenA = issue(h, {clientId: 'chatgpt_client_1'});
  const tokenB = issue(h, {clientId: 'claude_client_1'});
  const start = await toolCall(h, tokenA, 'start_connect_accounts');
  assert.equal((await complete(h, tokenB, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  })).body.error, 'invalid_link_challenge');
});

test('memory link store rejects unsafe challenge parameters', async () => {
  const store = new MemoryOwnerLinkStore();
  await assert.rejects(async () => store.createLinkChallenge({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    nowSeconds: now, ttlSeconds: 5
  }), error => error instanceof BridgeContractError);
});

test('model bearer cannot complete linking by sending forged verified provider IDs', async () => {
  const h = host();
  const token = issue(h);
  const start = await toolCall(h, token, 'start_connect_accounts');
  const id = start.body.challenge_id;
  const attackerClaims = {githubUserId: 9999, cloudflareAccountId: otherAccount};
  // Even a valid bearer and a valid fresh challenge cannot assert OAuth success.
  const forged = await untrustedHttpComplete(h, token, id, attackerClaims);
  assert.equal(forged.status, 404);
  assert.equal(forged.body.error, 'not_found');
  assert.equal((await h.links.peekChallenge(id)).consumedAt, null);
  assert.equal((await toolCall(h, token, 'get_connection_status')).body.linked, false);
  // An attacker also cannot smuggle a verification into an MCP tool call.
  assert.equal((await toolCall(h, token, 'complete_link', {
    challenge_id: id, verified: attackerClaims
  })).body.error, 'unknown_tool');
  // The internal mock callback can still simulate separately verified OAuth.
  assert.equal((await complete(h, token, id, {
    githubUserId: 123, cloudflareAccountId: account
  })).status, 200);
});

test('old first-time challenge cannot replace the owner after a second challenge links', async () => {
  const h = host();
  const token = issue(h);
  const first = await toolCall(h, token, 'start_connect_accounts');
  const second = await toolCall(h, token, 'start_connect_accounts');
  assert.equal((await complete(h, token, first.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  })).status, 200);
  const hijack = await complete(h, token, second.body.challenge_id, {
    githubUserId: 456, cloudflareAccountId: otherAccount
  });
  assert.equal(hijack.body.error, 'invalid_link_challenge');
  assert.equal((await h.links.peekChallenge(second.body.challenge_id)).consumedAt, null);
  assert.equal((await toolCall(h, token, 'get_connection_status')).body.github_user_id, 123);
});

test('concurrent reconnect challenges cannot replay an outdated authorization epoch', async () => {
  const h = host();
  const token = issue(h);
  const initial = await toolCall(h, token, 'start_connect_accounts');
  assert.equal((await complete(h, token, initial.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  })).body.authorization_epoch, 0);
  const first = await toolCall(h, token, 'start_connect_accounts');
  const second = await toolCall(h, token, 'start_connect_accounts');
  assert.equal((await complete(h, token, first.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  })).body.authorization_epoch, 1);
  const stale = await complete(h, token, second.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(stale.body.error, 'invalid_link_challenge');
  assert.equal((await toolCall(h, token, 'get_connection_status')).body.authorization_epoch, 1);
});
