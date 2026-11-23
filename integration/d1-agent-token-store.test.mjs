import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryD1} from './d1-support.mjs';
import {D1AgentTokenStore} from './d1-agent-token-store.mjs';
import {BRIDGE_AUDIENCE} from './tool-contract.mjs';
import {
  createBridgeHost, handleBridgeRequest
} from './bridge-transport.mjs';
import {D1OwnerLinkStore} from './d1-owner-link-store.mjs';
import {mintBrowserLinkTicket} from './browser-link-ticket.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const ticketKey = 'ef'.repeat(32);
const now = 1_700_000_000;
const ORIGIN = 'https://onboard.360web.cloud';

test('D1 token store hashes bearers and fences expiry/revoke', async () => {
  const {db, sqlite} = createMemoryD1();
  const tokens = new D1AgentTokenStore(db);
  const token = await tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now
  });
  assert.match(token, /^agt_[a-f0-9]{48}$/);
  const row = sqlite.prepare('SELECT token_hash, subject FROM bridge_agent_tokens').get();
  assert.equal(row.subject, 'owner_user_1234');
  assert.notEqual(row.token_hash, token);
  assert.equal((await tokens.lookup(token, {nowSeconds: now})).clientId, 'chatgpt_client_1');
  assert.equal(await tokens.lookup(token, {nowSeconds: now + 10_000}), null);
  await tokens.revoke(token);
  assert.equal(await tokens.lookup(token, {nowSeconds: now}), null);
});

test('createHostFromEnv-shaped D1 host authenticates tool calls', async () => {
  const {db} = createMemoryD1();
  const h = createBridgeHost({
    tokens: new D1AgentTokenStore(db),
    links: new D1OwnerLinkStore(db),
    nowSeconds: () => now,
    bridgeTicketKey: ticketKey
  });
  const token = await h.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now
  });
  const start = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name: 'start_connect_accounts', arguments: {}}
  });
  assert.equal(start.status, 200);
  const ticket = await mintBrowserLinkTicket(ticketKey, {
    challengeId: start.body.challenge_id,
    githubUserId: 123,
    cloudflareAccountId: account,
    nowSeconds: now
  });
  const linked = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/link/browser',
    body: {ticket}
  });
  assert.equal(linked.body.linked, true);
  const status = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name: 'get_connection_status', arguments: {}}
  });
  assert.equal(status.body.linked, true);
  assert.equal(status.body.github_user_id, 123);
  assert.equal(BRIDGE_AUDIENCE.startsWith('launch'), true);
});
