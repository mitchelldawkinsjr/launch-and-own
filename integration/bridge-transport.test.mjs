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

function toolCall(h, token, name, args = {}) {
  return handleBridgeRequest(h, {
    method: 'POST',
    url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name, arguments: args}
  });
}

// Test-only stand-in for a FUTURE trusted browser OAuth callback.
// It deliberately bypasses HTTP: callers cannot claim that model JSON
// containing "verified" is evidence from GitHub or Cloudflare OAuth.
// No production callback exists yet.
function complete(h, token, challengeId, verified) {
  const session = h.tokens.lookup(token, {nowSeconds: now});
  if (!session) return {status: 401, body: {error: 'unauthenticated'}};
  const principal = {
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: session.subject, clientId: session.clientId,
    expiresAt: session.expiresAt,
    linkedOwner: linkedOwnerFromStore(h.links, session.subject, session.clientId)
  };
  try {
    const record = h.links.consumeLinkChallenge({
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

function untrustedHttpComplete(h, token, challengeId, verified) {
  return handleBridgeRequest(h, {
    method: 'POST',
    url: ORIGIN + '/mcp/link/complete',
    headers: {authorization: 'Bearer ' + token},
    body: {challenge_id: challengeId, verified}
  });
}

test('protected resource metadata advertises provisional bridge markers', () => {
  const meta = protectedResourceMetadata();
  assert.equal(meta.resource, RESOURCE_URI);
  assert.equal(meta.launch_and_own.bridge_audience, BRIDGE_AUDIENCE);
  assert.equal(meta.launch_and_own.status, 'not_deployed');
  const h = host();
  const res = handleBridgeRequest(h, {
    method: 'GET', url: 'https://onboard.360web.cloud' + RESOURCE_METADATA_PATH
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.resource, RESOURCE_URI);
});

test('missing/wrong/expired bearer fails closed at the transport edge', () => {
  const h = host();
  const token = issue(h);
  assert.equal(toolCall(h, 'not-a-token', 'get_connection_status').body.error, 'unauthenticated');
  assert.equal(handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {}, body: {name: 'get_connection_status', arguments: {}}
  }).status, 401);
  now += 10_000;
  assert.equal(toolCall(h, token, 'get_connection_status').body.error, 'unauthenticated');
  now = 1_700_000_000;
});

test('model cannot inject owner identity through tool payload fields', () => {
  const h = host();
  const token = issue(h);
  assert.equal(handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {
      name: 'get_connection_status', arguments: {},
      linkedOwner: {githubUserId: 999, cloudflareAccountId: otherAccount}
    }
  }).body.error, 'invalid_arguments');
  assert.equal(toolCall(h, token, 'list_sites', {
    owner_id: 'someone_else'
  }).body.error, 'invalid_arguments');
});

test('first-time browser link binds providers; reconnect requires pinned IDs', () => {
  const h = host();
  const token = issue(h);
  const status0 = toolCall(h, token, 'get_connection_status');
  assert.equal(status0.status, 200);
  assert.equal(status0.body.linked, false);

  const start = toolCall(h, token, 'start_connect_accounts');
  assert.equal(start.status, 200);
  assert.equal(start.body.state, 'needs_browser_link');
  assert.equal(start.body.action_url, 'https://onboard.360web.cloud/');
  assert.equal(start.body.expectedGithubUserId, undefined);
  assert.equal(start.body.oauth_state, undefined);

  const linked = complete(h, token, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.linked, true);
  assert.equal(linked.body.authorization_epoch, 0);

  // Replay of the same challenge fails closed.
  assert.equal(complete(h, token, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  }).body.error, 'invalid_link_challenge');

  const status1 = toolCall(h, token, 'get_connection_status');
  assert.equal(status1.body.linked, true);
  assert.equal(status1.body.github_user_id, 123);

  // Reconnect with matching pins succeeds and bumps epoch.
  const reconnect = toolCall(h, token, 'start_connect_accounts');
  const again = complete(h, token, reconnect.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(again.body.authorization_epoch, 1);

  // Different verified Cloudflare account fails closed.
  const bad = toolCall(h, token, 'start_connect_accounts');
  assert.equal(complete(h, token, bad.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: otherAccount
  }).body.error, 'invalid_link_challenge');
});

test('linked tools stay unavailable until site adapters exist; unlinked tools stay gated', () => {
  const h = host();
  const token = issue(h);
  assert.equal(toolCall(h, token, 'list_sites').body.error, 'needs_reauthorization');

  const start = toolCall(h, token, 'start_connect_accounts');
  complete(h, token, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(toolCall(h, token, 'list_sites').status, 501);
  assert.equal(toolCall(h, token, 'list_sites').body.error, 'not_implemented');
});

test('wrong client cannot consume another client challenge', () => {
  const h = host();
  const tokenA = issue(h, {clientId: 'chatgpt_client_1'});
  const tokenB = issue(h, {clientId: 'claude_client_1'});
  const start = toolCall(h, tokenA, 'start_connect_accounts');
  assert.equal(complete(h, tokenB, start.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  }).body.error, 'invalid_link_challenge');
});

test('memory link store rejects unsafe challenge parameters', () => {
  const store = new MemoryOwnerLinkStore();
  assert.throws(() => store.createLinkChallenge({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    nowSeconds: now, ttlSeconds: 5
  }), error => error instanceof BridgeContractError);
});


test('model bearer cannot complete linking by sending forged verified provider IDs', () => {
  const h = host();
  const token = issue(h);
  const start = toolCall(h, token, 'start_connect_accounts');
  const id = start.body.challenge_id;
  const attackerClaims = {githubUserId: 9999, cloudflareAccountId: otherAccount};
  // Even a valid bearer and a valid fresh challenge cannot assert OAuth success.
  const forged = untrustedHttpComplete(h, token, id, attackerClaims);
  assert.equal(forged.status, 404);
  assert.equal(forged.body.error, 'not_found');
  assert.equal(h.links.peekChallenge(id).consumedAt, null);
  assert.equal(toolCall(h, token, 'get_connection_status').body.linked, false);
  // An attacker also cannot smuggle a verification into an MCP tool call.
  assert.equal(toolCall(h, token, 'complete_link', {
    challenge_id: id, verified: attackerClaims
  }).body.error, 'unknown_tool');
  // The internal mock callback can still simulate separately verified OAuth.
  assert.equal(complete(h, token, id, {
    githubUserId: 123, cloudflareAccountId: account
  }).status, 200);
});

test('old first-time challenge cannot replace the owner after a second challenge links', () => {
  const h = host();
  const token = issue(h);
  const first = toolCall(h, token, 'start_connect_accounts');
  const second = toolCall(h, token, 'start_connect_accounts');
  assert.equal(complete(h, token, first.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  }).status, 200);
  const hijack = complete(h, token, second.body.challenge_id, {
    githubUserId: 456, cloudflareAccountId: otherAccount
  });
  assert.equal(hijack.body.error, 'invalid_link_challenge');
  assert.equal(h.links.peekChallenge(second.body.challenge_id).consumedAt, null);
  assert.equal(toolCall(h, token, 'get_connection_status').body.github_user_id, 123);
});

test('concurrent reconnect challenges cannot replay an outdated authorization epoch', () => {
  const h = host();
  const token = issue(h);
  const initial = toolCall(h, token, 'start_connect_accounts');
  assert.equal(complete(h, token, initial.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  }).body.authorization_epoch, 0);
  const first = toolCall(h, token, 'start_connect_accounts');
  const second = toolCall(h, token, 'start_connect_accounts');
  assert.equal(complete(h, token, first.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  }).body.authorization_epoch, 1);
  const stale = complete(h, token, second.body.challenge_id, {
    githubUserId: 123, cloudflareAccountId: account
  });
  assert.equal(stale.body.error, 'invalid_link_challenge');
  assert.equal(toolCall(h, token, 'get_connection_status').body.authorization_epoch, 1);
});
