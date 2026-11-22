/**
 * Tenant-scoped publication job projection for the shared agent bridge.
 * Memory adapter only — does not call GitHub/Cloudflare. A future D1 adapter
 * must load the same ownership fields and trusted verification booleans from
 * the existing onboarding job runner, never from model arguments.
 */
import {randomBytes} from 'node:crypto';
import {
  BridgeContractError, assertOwnedRecord, publicationStatus
} from './tool-contract.mjs';

const deny = code => { throw new BridgeContractError(code); };
const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const SAFE = new Set([
  'draft', 'queued', 'pending_deployment', 'needs_reauthorization', 'failed', 'live'
]);

function newId(prefix) {
  return prefix + '_' + randomBytes(10).toString('hex');
}

function ownerFields(scope) {
  return {
    subject: scope.subject,
    githubUserId: scope.owner.githubUserId,
    cloudflareAccountId: scope.owner.cloudflareAccountId,
    authorizationEpoch: scope.owner.authorizationEpoch
  };
}

export class MemoryJobPublicationStore {
  #jobs = new Map();

  /**
   * Host/test seam: create a durable job row already owned by scope.
   * Never callable from model tool arguments.
   */
  seedJob(scope, {
    status = 'queued',
    siteId = null,
    approvedHtmlSha256 = null
  } = {}) {
    if (!scope?.owner) deny('needs_reauthorization');
    if (!SAFE.has(status)) deny('invalid_publication_status');
    const id = newId('job');
    const record = {
      id, ...ownerFields(scope),
      status,
      siteId,
      approvedHtmlSha256,
      canonicalProductionVerified: false,
      publicHtmlVerified: false,
      productionCommitSha: null,
      verifiedCommitSha: null,
      publicHtmlSha256: null
    };
    this.#jobs.set(id, record);
    return Object.freeze({...record});
  }

  /**
   * Host/test seam: attach independently obtained verification facts.
   * Rejects model-shaped payloads that omit proof or disagree on digests.
   */
  attachTrustedVerification(scope, jobId, {
    productionCommitSha,
    publicHtmlSha256,
    approvedHtmlSha256 = null,
    markLive = false
  }) {
    const job = this.#jobs.get(jobId);
    assertOwnedRecord(job || {subject: ''}, scope);
    if (!SHA.test(String(productionCommitSha)) || !DIGEST.test(String(publicHtmlSha256)))
      deny('invalid_publication_status');
    const approved = approvedHtmlSha256 || job.approvedHtmlSha256;
    if (!DIGEST.test(String(approved)) ||
        String(publicHtmlSha256).toLowerCase() !== String(approved).toLowerCase())
      deny('invalid_publication_status');
    job.productionCommitSha = String(productionCommitSha).toLowerCase();
    job.verifiedCommitSha = job.productionCommitSha;
    job.publicHtmlSha256 = String(publicHtmlSha256).toLowerCase();
    job.approvedHtmlSha256 = String(approved).toLowerCase();
    job.canonicalProductionVerified = true;
    job.publicHtmlVerified = true;
    if (markLive) job.status = 'live';
    this.#jobs.set(jobId, job);
    return Object.freeze({...job});
  }

  setStatus(scope, jobId, status) {
    const job = this.#jobs.get(jobId);
    assertOwnedRecord(job || {subject: ''}, scope);
    if (!SAFE.has(status)) deny('invalid_publication_status');
    job.status = status;
    this.#jobs.set(jobId, job);
    return Object.freeze({...job});
  }

  getJob(scope, jobId) {
    const job = this.#jobs.get(jobId);
    assertOwnedRecord(job || {subject: ''}, scope);
    return publicationStatus(job, scope);
  }

  /**
   * verify_publication uses the same projection as get_job_status, but refuses
   * to invent live success when proof is incomplete (returns pending_deployment).
   */
  verifyPublication(scope, jobId) {
    return this.getJob(scope, jobId);
  }
}
