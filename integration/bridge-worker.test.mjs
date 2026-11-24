import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {createBridgeFetch} from './bridge-worker.mjs';
import {createBridgeHost, MemoryAgentTokenStore} from './bridge-transport.mjs';
import {MemoryOwnerLinkStore} from './owner-link-store.mjs';
import {BRIDGE_AUDIENCE} from './tool-contract.mjs';
import {RESOURCE_METADATA_PATH} from './protected-resource.mjs';

const ORIGIN = 'https://onboard.360web.cloud';
let now = 1_700_000_000;

test('undeployed Worker refuses traffic with not_deployed', async () => {
  const res = await worker.fetch(new Request(ORIGIN + '/mcp/tools/call', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: '{}'
  }), {BRIDGE_DEPLOYMENT: 'not_approved'});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_deployed');
  const icon = await worker.fetch(new Request(ORIGIN + '/launch-and-own-icon.png'),
    {BRIDGE_DEPLOYMENT: 'not_approved'});
  assert.equal(icon.status, 503);
});

test('approved Fetch adapter serves metadata and authenticated tool calls', async () => {
  const host = createBridgeHost({
    tokens: new MemoryAgentTokenStore(),
    links: new MemoryOwnerLinkStore(),
    nowSeconds: () => now
  });
  const fetch = createBridgeFetch(host);
  const meta = await fetch(new Request(ORIGIN + RESOURCE_METADATA_PATH));
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).launch_and_own.status, 'deployed_gated');

  const token = host.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now,
    audience: BRIDGE_AUDIENCE
  });
  const status = await fetch(new Request(ORIGIN + '/mcp/tools/call', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token
    },
    body: JSON.stringify({name: 'get_connection_status', arguments: {}})
  }));
  assert.equal(status.status, 200);
  assert.equal((await status.json()).linked, false);
});

test('approved default export still uses injected host without claiming production OAuth', async () => {
  const host = createBridgeHost({
    tokens: new MemoryAgentTokenStore(),
    links: new MemoryOwnerLinkStore(),
    nowSeconds: () => now
  });
  const token = host.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now
  });
  const res = await worker.fetch(new Request(ORIGIN + '/mcp/tools/call', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token
    },
    body: JSON.stringify({name: 'get_connection_status', arguments: {}})
  }), {BRIDGE_DEPLOYMENT: 'approved', __bridgeHost: host});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).linked, false);
});

test('bridge Worker modules never statically import node:sqlite (Workers bundle)', async () => {
  const {readFileSync, readdirSync} = await import('node:fs');
  const dir = new URL('.', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs')))
    assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), /^import .*['"]node:sqlite['"]/m, file);
});

test('approved deployment requires persistent authorization configuration', async () => {
  const req = new Request('https://mcp.360web.cloud/.well-known/oauth-protected-resource/mcp');
  for (const env of [
    {BRIDGE_DEPLOYMENT: 'approved'},
    {BRIDGE_DEPLOYMENT: 'approved', DB: {prepare() {}, batch() {}}},
    {BRIDGE_DEPLOYMENT: 'approved', DB: {prepare() {}, batch() {}},
      BRIDGE_TICKET_KEY: 'a'.repeat(64), ONBOARDING_ORIGIN: 'https://unregistered.example'}
  ]) {
    const response = await worker.fetch(req, env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'service_unavailable'});
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
