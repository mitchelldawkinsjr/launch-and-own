import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBridgeHost, handleBridgeRequest, MemoryAgentTokenStore
} from './bridge-transport.mjs';
import {MemoryOwnerLinkStore} from './owner-link-store.mjs';
import {MemorySiteDraftStore} from './site-draft-store.mjs';
import {MemoryJobPublicationStore} from './job-publication-store.mjs';
import {
  assertTrustedPrincipal, BridgeContractError, BRIDGE_AUDIENCE
} from './tool-contract.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const otherAccount = 'abcdef0123456789abcdef012345678a';
const sha = 'a'.repeat(40);
const digest = 'c'.repeat(64);
const otherDigest = 'd'.repeat(64);
let now = 1_700_000_000;
const ORIGIN = 'https://onboard.360web.cloud';

async function linkedHost() {
  const h = createBridgeHost({
    tokens: new MemoryAgentTokenStore(),
    links: new MemoryOwnerLinkStore(),
    sites: new MemorySiteDraftStore(),
    jobs: new MemoryJobPublicationStore(),
    nowSeconds: () => now
  });
  const token = h.tokens.issue({
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1', nowSeconds: now
  });
  const start = await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name: 'start_connect_accounts', arguments: {}}
  });
  const session = h.tokens.lookup(token, {nowSeconds: now});
  await h.links.consumeLinkChallenge({
    challengeId: start.body.challenge_id,
    verifiedIdentity: {githubUserId: 123, cloudflareAccountId: account},
    principal: {
      authenticated: true, audience: BRIDGE_AUDIENCE,
      subject: session.subject, clientId: session.clientId,
      expiresAt: session.expiresAt, linkedOwner: null
    },
    nowSeconds: now
  });
  const scope = assertTrustedPrincipal({
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_1234', clientId: 'chatgpt_client_1',
    expiresAt: now + 60,
    linkedOwner: {
      githubUserId: 123, cloudflareAccountId: account,
      authorizationEpoch: 0, reauthorized: true
    }
  }, {nowSeconds: now});
  return {h, token, scope};
}

async function call(h, token, name, args = {}) {
  return await handleBridgeRequest(h, {
    method: 'POST', url: ORIGIN + '/mcp/tools/call',
    headers: {authorization: 'Bearer ' + token},
    body: {name, arguments: args}
  });
}

test('queued jobs stay truthful; live requires trusted commit and HTML proof', async () => {
  const {h, token, scope} = await linkedHost();
  const job = h.jobs.seedJob(scope, {status: 'queued', approvedHtmlSha256: digest});
  const queued = await call(h, token, 'get_job_status', {job_id: job.id});
  assert.deepEqual(queued.body, {job_id: job.id, state: 'queued'});

  // Claiming live without verification facts still projects pending_deployment.
  h.jobs.setStatus(scope, job.id, 'live');
  assert.deepEqual((await call(h, token, 'verify_publication', {job_id: job.id})).body, {
    job_id: job.id, state: 'pending_deployment'
  });

  h.jobs.attachTrustedVerification(scope, job.id, {
    productionCommitSha: sha,
    publicHtmlSha256: digest,
    markLive: true
  });
  assert.deepEqual((await call(h, token, 'verify_publication', {job_id: job.id})).body, {
    job_id: job.id, state: 'live',
    production_commit_sha: sha, public_html_sha256: digest
  });
});

test('verify_publication never accepts mismatched HTML digests as live', async () => {
  const {h, scope} = await linkedHost();
  const job = h.jobs.seedJob(scope, {status: 'pending_deployment', approvedHtmlSha256: digest});
  assert.throws(() => h.jobs.attachTrustedVerification(scope, job.id, {
    productionCommitSha: sha,
    publicHtmlSha256: otherDigest
  }), err => err instanceof BridgeContractError && err.code === 'invalid_publication_status');
});

test('job IDs are tenant-fenced and projections omit secrets', async () => {
  const {h, token, scope} = await linkedHost();
  const job = h.jobs.seedJob(scope, {status: 'failed', approvedHtmlSha256: digest});
  const verified = h.jobs.attachTrustedVerification(scope, job.id, {
    productionCommitSha: sha, publicHtmlSha256: digest, markLive: true
  });
  const live = await call(h, token, 'get_job_status', {job_id: verified.id});
  assert.equal(live.body.state, 'live');
  assert.deepEqual(Object.keys(live.body).sort(), [
    'job_id', 'production_commit_sha', 'public_html_sha256', 'state'
  ]);

  const foreign = assertTrustedPrincipal({
    authenticated: true, audience: BRIDGE_AUDIENCE,
    subject: 'owner_user_other', clientId: 'chatgpt_client_1',
    expiresAt: now + 60,
    linkedOwner: {
      githubUserId: 999, cloudflareAccountId: otherAccount,
      authorizationEpoch: 0, reauthorized: true
    }
  }, {nowSeconds: now});
  assert.throws(() => h.jobs.getJob(foreign, job.id),
    err => err instanceof BridgeContractError && err.code === 'not_found');
  assert.equal((await call(h, token, 'get_job_status', {job_id: 'job_guessed'})).body.error,
    'not_found');
});
