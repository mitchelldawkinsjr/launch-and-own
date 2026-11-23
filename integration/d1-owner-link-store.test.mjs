import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryD1} from './d1-support.mjs';
import {D1OwnerLinkStore} from './d1-owner-link-store.mjs';
import {BRIDGE_AUDIENCE, BridgeContractError} from './tool-contract.mjs';
import {
  createBridgeHost, handleBridgeRequest, MemoryAgentTokenStore
} from './bridge-transport.mjs';
import {mintBrowserLinkTicket} from './browser-link-ticket.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const otherAccount = 'abcdef0123456789abcdef012345678a';
const ticketKey = 'ab'.repeat(32);
let now = 1_700_000_000;
const ORIGIN = 'https://onboard.360web.cloud';

test('D1 link store first-time bind and reconnect pin fencing', async () => {
  const {db} = createMemoryD1();
  const links = new D1OwnerLinkStore(db);
  const principal = {
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    expiresAt: now + 60, linkedOwner: null
  };
  const challenge = await links.createLinkChallenge({
    subject: principal.subject, clientId: principal.clientId, nowSeconds: now
  });
  const linked = await links.consumeLinkChallenge({
    challengeId: challenge.id,
    verifiedIdentity: {githubUserId: 123, cloudflareAccountId: account},
    principal, nowSeconds: now
  });
  assert.equal(linked.authorizationEpoch, 0);

  const principal2 = {
    ...principal,
    linkedOwner: {
      githubUserId: 123, cloudflareAccountId: account,
      authorizationEpoch: 0, reauthorized: true
    }
  };
  const reconnect = await links.createLinkChallenge({
    subject: principal.subject, clientId: principal.clientId, nowSeconds: now
  });
  await assert.rejects(() => links.consumeLinkChallenge({
    challengeId: reconnect.id,
    verifiedIdentity: {githubUserId: 123, cloudflareAccountId: otherAccount},
    principal: principal2, nowSeconds: now
  }), err => err instanceof BridgeContractError);

  const ok = await links.consumeLinkChallenge({
    challengeId: reconnect.id,
    verifiedIdentity: {githubUserId: 123, cloudflareAccountId: account},
    principal: principal2, nowSeconds: now
  });
  assert.equal(ok.authorizationEpoch, 1);
});

test('sealed browser ticket completes link; raw verified map still 404', async () => {
  const {db} = createMemoryD1();
  const h = createBridgeHost({
    tokens: new MemoryAgentTokenStore(),
    links: new D1OwnerLinkStore(db),
    nowSeconds: () => now,
    bridgeTicketKey: ticketKey
  });
  const token = h.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now
  });
  const start = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name: 'start_connect_accounts', arguments: {}}
  });
  assert.equal(start.status, 200);

  const forged = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/link/browser',
    headers: {authorization: 'Bearer ' + token},
    body: {
      ticket: 'not-a-ticket',
      verified: {githubUserId: 999, cloudflareAccountId: otherAccount}
    }
  });
  assert.equal(forged.body.error, 'invalid_link_challenge');

  const ticket = await mintBrowserLinkTicket(ticketKey, {
    challengeId: start.body.challenge_id,
    githubUserId: 123,
    cloudflareAccountId: account,
    nowSeconds: now
  });
  // Ticket-only (no agent Bearer): onboarding Worker path.
  const linked = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/link/browser',
    headers: {},
    body: {ticket}
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.linked, true);
  assert.equal(linked.body.github_user_id, 123);

  const status = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name: 'get_connection_status', arguments: {}}
  });
  assert.equal(status.body.linked, true);
});
