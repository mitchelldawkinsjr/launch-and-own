/**
 * D1-backed publication job projection for the shared agent bridge.
 * Does not call GitHub/Cloudflare. Verification facts must be attached by a
 * trusted host/runner — never from model arguments.
 */
import {randomBytes} from 'node:crypto';
import {
  BridgeContractError, assertOwnedRecord, publicationStatus
} from './tool-contract.mjs';
import {d1First, d1Run} from './d1-support.mjs';

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

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    subject: row.subject,
    githubUserId: row.github_user_id,
    cloudflareAccountId: String(row.cloudflare_account_id).toLowerCase(),
    authorizationEpoch: row.authorization_epoch,
    status: row.status,
    siteId: row.site_id,
    approvedHtmlSha256: row.approved_html_sha256,
    canonicalProductionVerified: row.canonical_production_verified === 1,
    publicHtmlVerified: row.public_html_verified === 1,
    productionCommitSha: row.production_commit_sha,
    verifiedCommitSha: row.verified_commit_sha,
    publicHtmlSha256: row.public_html_sha256
  };
}

export class D1JobPublicationStore {
  constructor(db) {
    this.db = db;
  }

  async seedJob(scope, {
    status = 'queued',
    siteId = null,
    approvedHtmlSha256 = null
  } = {}) {
    if (!scope?.owner) deny('needs_reauthorization');
    if (!SAFE.has(status)) deny('invalid_publication_status');
    const id = newId('job');
    const owner = ownerFields(scope);
    const now = 0;
    await d1Run(this.db, `
      INSERT INTO bridge_jobs (
        id, subject, github_user_id, cloudflare_account_id, authorization_epoch,
        status, site_id, approved_html_sha256, canonical_production_verified,
        public_html_verified, production_commit_sha, verified_commit_sha,
        public_html_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?)`,
    id, owner.subject, owner.githubUserId, owner.cloudflareAccountId,
    owner.authorizationEpoch, status, siteId, approvedHtmlSha256, now, now);
    return Object.freeze({
      id, ...owner, status, siteId, approvedHtmlSha256,
      canonicalProductionVerified: false,
      publicHtmlVerified: false,
      productionCommitSha: null,
      verifiedCommitSha: null,
      publicHtmlSha256: null
    });
  }

  async attachTrustedVerification(scope, jobId, {
    productionCommitSha,
    publicHtmlSha256,
    approvedHtmlSha256 = null,
    markLive = false
  }) {
    const job = rowToJob(await d1First(this.db,
      `SELECT * FROM bridge_jobs WHERE id = ?`, jobId));
    assertOwnedRecord(job || {subject: ''}, scope);
    if (!SHA.test(String(productionCommitSha)) || !DIGEST.test(String(publicHtmlSha256)))
      deny('invalid_publication_status');
    const approved = approvedHtmlSha256 || job.approvedHtmlSha256;
    if (!DIGEST.test(String(approved)) ||
        String(publicHtmlSha256).toLowerCase() !== String(approved).toLowerCase())
      deny('invalid_publication_status');
    const production = String(productionCommitSha).toLowerCase();
    const publicDigest = String(publicHtmlSha256).toLowerCase();
    const approvedDigest = String(approved).toLowerCase();
    const status = markLive ? 'live' : job.status;
    await d1Run(this.db, `
      UPDATE bridge_jobs SET
        production_commit_sha = ?, verified_commit_sha = ?,
        public_html_sha256 = ?, approved_html_sha256 = ?,
        canonical_production_verified = 1, public_html_verified = 1,
        status = ?, updated_at = ?
      WHERE id = ? AND subject = ? AND authorization_epoch = ?`,
    production, production, publicDigest, approvedDigest, status, 0,
    jobId, scope.subject, scope.owner.authorizationEpoch);
    return Object.freeze({
      ...job,
      productionCommitSha: production,
      verifiedCommitSha: production,
      publicHtmlSha256: publicDigest,
      approvedHtmlSha256: approvedDigest,
      canonicalProductionVerified: true,
      publicHtmlVerified: true,
      status
    });
  }

  async setStatus(scope, jobId, status) {
    const job = rowToJob(await d1First(this.db,
      `SELECT * FROM bridge_jobs WHERE id = ?`, jobId));
    assertOwnedRecord(job || {subject: ''}, scope);
    if (!SAFE.has(status)) deny('invalid_publication_status');
    await d1Run(this.db, `
      UPDATE bridge_jobs SET status = ?, updated_at = ?
      WHERE id = ? AND subject = ? AND authorization_epoch = ?`,
    status, 0, jobId, scope.subject, scope.owner.authorizationEpoch);
    return Object.freeze({...job, status});
  }

  async getJob(scope, jobId) {
    const job = rowToJob(await d1First(this.db,
      `SELECT * FROM bridge_jobs WHERE id = ?`, jobId));
    assertOwnedRecord(job || {subject: ''}, scope);
    return publicationStatus(job, scope);
  }

  async verifyPublication(scope, jobId) {
    return this.getJob(scope, jobId);
  }
}
