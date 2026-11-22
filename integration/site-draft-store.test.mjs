import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBridgeHost, handleBridgeRequest, MemoryAgentTokenStore
} from './bridge-transport.mjs';
import {MemoryOwnerLinkStore} from './owner-link-store.mjs';
import {MemorySiteDraftStore, previewDigestFromSpec} from './site-draft-store.mjs';
import {assertTrustedPrincipal, BridgeContractError, BRIDGE_AUDIENCE} from './tool-contract.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const otherAccount = 'abcdef0123456789abcdef012345678a';
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
let now = 1_700_000_000;
const ORIGIN = 'https://onboard.360web.cloud';
const spec = {
  name: 'Willow Studio', headline: 'Beautiful hand-crafted design',
  about: 'Locally owned.', services: ['Design', 'Consulting'], theme: 'forest'
};

function linkedHost(extra = {}) {
  const h = createBridgeHost({
    tokens: new MemoryAgentTokenStore(),
    links: new MemoryOwnerLinkStore(),
    sites: new MemorySiteDraftStore(),
    nowSeconds: () => now,
    currentCommitSha: sha,
    currentRepositoryId: 456,
    ...extra
  });
  const token = h.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now
  });
  const start = handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name: 'start_connect_accounts', arguments: {}}
  });
  handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/link/complete',
    headers: {authorization: 'Bearer ' + token},
    body: {
      challenge_id: start.body.challenge_id,
      verified: {githubUserId: 123, cloudflareAccountId: account}
    }
  });
  return {h, token};
}

function call(h, token, name, args = {}) {
  return handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name, arguments: args}
  });
}

test('prepare_site freezes a digest and approval handoff never returns tokens', () => {
  const {h, token} = linkedHost();
  const prepared = call(h, token, 'prepare_site', {site_spec: spec});
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.preview_sha256, previewDigestFromSpec(spec));
  assert.equal(prepared.body.operation, 'create');

  const preview = call(h, token, 'get_exact_preview', {draft_id: prepared.body.draft_id});
  assert.equal(preview.body.preview_sha256, prepared.body.preview_sha256);

  const approval = call(h, token, 'request_explicit_approval', {
    draft_id: prepared.body.draft_id,
    preview_sha256: prepared.body.preview_sha256,
    idempotency_key: 'idem_12345678901234'
  });
  assert.equal(approval.body.state, 'needs_human_approval');
  assert.equal(approval.body.action_url, ORIGIN + '/review');
  assert.equal(approval.body.token, undefined);
  assert.equal(approval.body.approved, undefined);

  assert.equal(call(h, token, 'request_explicit_approval', {
    draft_id: prepared.body.draft_id,
    preview_sha256: 'e'.repeat(64),
    idempotency_key: 'idem_12345678901234'
  }).body.error, 'stale_preview');
});

test('site inventory is tenant-fenced across linked owners', () => {
  const {h, token} = linkedHost();
  const scope = assertTrustedPrincipal({
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    expiresAt: now + 60,
    linkedOwner: {
      githubUserId: 123, cloudflareAccountId: account,
      authorizationEpoch: 0, reauthorized: true
    }
  }, {nowSeconds: now});
  const site = h.sites.seedSite(scope, {name: 'Willow Studio'});
  const listed = call(h, token, 'list_sites');
  assert.deepEqual(listed.body.sites, [
    {site_id: site.id, name: 'Willow Studio', status: 'draft'}
  ]);
  assert.equal(call(h, token, 'get_site', {site_id: site.id}).body.name, 'Willow Studio');
  assert.equal(call(h, token, 'get_site', {site_id: 'site_guessed_other'}).body.error,
    'not_found');
});

test('prepare_site_update rejects stale Git base from trusted host facts', () => {
  const {h, token} = linkedHost();
  const scope = assertTrustedPrincipal({
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    expiresAt: now + 60,
    linkedOwner: {
      githubUserId: 123, cloudflareAccountId: account,
      authorizationEpoch: 0, reauthorized: true
    }
  }, {nowSeconds: now});
  const site = h.sites.seedSite(scope, {name: 'Willow Studio'});

  const ok = call(h, token, 'prepare_site_update', {
    site_id: site.id, base_commit_sha: sha, changes: {headline: 'New'}
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.operation, 'update');

  h.currentCommitSha = otherSha;
  assert.equal(call(h, token, 'prepare_site_update', {
    site_id: site.id, base_commit_sha: sha, changes: {headline: 'Newer'}
  }).body.error, 'stale_source');
});

test('cross-tenant site id guesses fail closed', () => {
  const store = new MemorySiteDraftStore();
  const scopeA = assertTrustedPrincipal({
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_aaaa', clientId: 'chatgpt_client_1',
    expiresAt: now + 60,
    linkedOwner: {
      githubUserId: 111, cloudflareAccountId: account,
      authorizationEpoch: 1, reauthorized: true
    }
  }, {nowSeconds: now});
  const scopeB = assertTrustedPrincipal({
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_bbbb', clientId: 'chatgpt_client_1',
    expiresAt: now + 60,
    linkedOwner: {
      githubUserId: 222, cloudflareAccountId: otherAccount,
      authorizationEpoch: 1, reauthorized: true
    }
  }, {nowSeconds: now});
  const site = store.seedSite(scopeA, {name: 'Private'});
  assert.throws(() => store.getSite(scopeB, site.id),
    err => err instanceof BridgeContractError && err.code === 'not_found');
  assert.deepEqual(store.listSites(scopeB), []);
});
