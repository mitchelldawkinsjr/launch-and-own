import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryD1} from './d1-support.mjs';
import {D1SiteDraftStore} from './d1-site-draft-store.mjs';
import {D1JobPublicationStore} from './d1-job-publication-store.mjs';
import {BridgeContractError} from './tool-contract.mjs';
import {previewDigestFromSpec} from './site-draft-store.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const otherAccount = 'abcdef0123456789abcdef012345678a';
const digest = 'c'.repeat(64);
const sha = 'a'.repeat(40);
const now = 1_700_000_000;
const spec = {
  name: 'Willow Studio', headline: 'Beautiful hand-crafted design',
  about: 'Locally owned.', services: ['Design', 'Consulting'], theme: 'forest'
};

function scope(overrides = {}) {
  return {
    subject: 'owner_user_1234',
    owner: {
      githubUserId: 123,
      cloudflareAccountId: account,
      authorizationEpoch: 0,
      reauthorized: true
    },
    ...overrides
  };
}

test('D1 site store fences inventory and freezes create digests', async () => {
  const {db} = createMemoryD1();
  const sites = new D1SiteDraftStore(db);
  const mine = scope();
  await sites.seedSite(mine, {name: 'Willow Studio'});
  await sites.seedSite({
    subject: 'other',
    owner: {
      githubUserId: 999, cloudflareAccountId: otherAccount,
      authorizationEpoch: 0, reauthorized: true
    }
  }, {name: 'Other'});

  const listed = await sites.listSites(mine);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Willow Studio');

  const prepared = await sites.prepareSite(mine, spec, {nowSeconds: now});
  assert.equal(prepared.preview_sha256, previewDigestFromSpec(spec));
  const preview = await sites.getExactPreview(mine, prepared.draft_id, {nowSeconds: now});
  assert.equal(preview.preview_sha256, prepared.preview_sha256);

  const handoff = await sites.requestApproval(mine, {
    draftId: prepared.draft_id,
    previewSha256: prepared.preview_sha256,
    idempotencyKey: 'idem-1'
  }, {nowSeconds: now});
  assert.equal(handoff.state, 'needs_human_approval');
  // Duplicate key must not throw; still returns a safe handoff.
  const again = await sites.requestApproval(mine, {
    draftId: prepared.draft_id,
    previewSha256: prepared.preview_sha256,
    idempotencyKey: 'idem-1'
  }, {nowSeconds: now});
  assert.equal(again.draft_id, prepared.draft_id);
});

test('D1 job store requires trusted proof before projecting live', async () => {
  const {db} = createMemoryD1();
  const jobs = new D1JobPublicationStore(db);
  const mine = scope();
  const job = await jobs.seedJob(mine, {status: 'queued', approvedHtmlSha256: digest});
  assert.equal((await jobs.getJob(mine, job.id)).state, 'queued');

  await jobs.setStatus(mine, job.id, 'live');
  assert.equal((await jobs.getJob(mine, job.id)).state, 'pending_deployment');

  await jobs.attachTrustedVerification(mine, job.id, {
    productionCommitSha: sha,
    publicHtmlSha256: digest,
    markLive: true
  });
  const live = await jobs.verifyPublication(mine, job.id);
  assert.equal(live.state, 'live');
  assert.equal(live.production_commit_sha, sha);

  await assert.rejects(() => jobs.getJob({
    subject: 'foreign',
    owner: {
      githubUserId: 999, cloudflareAccountId: otherAccount,
      authorizationEpoch: 0, reauthorized: true
    }
  }, job.id), err => err instanceof BridgeContractError);
});
