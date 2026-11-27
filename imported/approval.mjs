import { jcs, sha256Bytes, sha256Text } from './bytes.mjs';
import { ImportedEditError } from './errors.mjs';
import { artifactDigest, treeDigest } from './preview.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const APPROVAL_ID = /^[a-f0-9]{32}$/;
const REVIEW_SECONDS = 15 * 60;

export function newApprovalId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeChanged(changed) {
  // Span edits stay at most 5 files. A visual snapshot may also add a few images.
  if (!Array.isArray(changed) || changed.length === 0 || changed.length > 8) throw new ImportedEditError('approval-digest-mismatch');
  const rows = changed.map(row => {
    if (!row || typeof row.path !== 'string' || !row.path.startsWith('public/') || row.path.includes('..')
        || !DIGEST.test(row.afterSha256 || '')) {
      throw new ImportedEditError('approval-digest-mismatch');
    }
    if (row.added === true) return { path: row.path, added: true, afterSha256: row.afterSha256 };
    if (!SHA.test(row.beforeBlobSha || '')) throw new ImportedEditError('approval-digest-mismatch');
    return { path: row.path, beforeBlobSha: row.beforeBlobSha.toLowerCase(), afterSha256: row.afterSha256 };
  });
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const paths = new Set();
  for (const row of rows) {
    if (paths.has(row.path)) throw new ImportedEditError('approval-digest-mismatch');
    paths.add(row.path);
  }
  return rows;
}

export function approvalBody(receipt) {
  return {
    v: 1,
    approvalId: receipt.approvalId,
    proposalDigest: receipt.proposalDigest,
    repositoryId: receipt.repositoryId,
    owner: { provider: receipt.owner.provider, id: receipt.owner.id },
    baseCommitSha: receipt.baseCommitSha,
    changed: receipt.changed,
    artifactDigest: receipt.artifactDigest,
    previewUrl: receipt.previewUrl,
    expiresAt: receipt.expiresAt
  };
}

export async function approvalDigest(receipt) {
  return sha256Text(jcs(approvalBody(receipt)));
}

export async function bindApproval({
  explicitlyApproved, preview, changed, githubUserId, repositoryId, ownerLogin, repository,
  baseCommitSha, proposalDigest, approvalId, expiresAt, owner
}) {
  // owner: the customer-owned assistant binds its Access identity. Hosted callers omit it and keep the GitHub owner.
  if (owner !== undefined && (owner?.provider !== 'cloudflare_access' || typeof owner.id !== 'string' || owner.id.length < 1 || owner.id.length > 80)) {
    throw new ImportedEditError('approval-owner-mismatch');
  }
  if (explicitlyApproved !== true) throw new ImportedEditError('approval-required');
  if (!preview || preview.credentialsIncluded !== false) throw new ImportedEditError('invalid-preview');
  if (!Number.isSafeInteger(githubUserId) || githubUserId < 1 || preview.githubUserId !== githubUserId) throw new ImportedEditError('approval-owner-mismatch');
  if (!APPROVAL_ID.test(approvalId || '') || !DIGEST.test(proposalDigest || '')) throw new ImportedEditError('approval-digest-mismatch');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || preview.repositoryId !== repositoryId) throw new ImportedEditError('approval-repo-mismatch');
  if (typeof ownerLogin !== 'string' || preview.ownerLogin !== ownerLogin) throw new ImportedEditError('approval-owner-mismatch');
  if (typeof repository !== 'string' || repository !== ownerLogin + '/' + repository.slice(ownerLogin.length + 1)) throw new ImportedEditError('approval-repo-mismatch');
  if (!/^esp-[a-z0-9-]{1,40}$/.test(repository.slice(ownerLogin.length + 1))) throw new ImportedEditError('approval-repo-mismatch');
  if (typeof baseCommitSha !== 'string' || !SHA.test(baseCommitSha) || preview.baseCommitSha !== baseCommitSha.toLowerCase()) {
    throw new ImportedEditError('approval-base-mismatch');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt)) expiresAt = now + REVIEW_SECONDS;
  if (expiresAt <= now || expiresAt > now + REVIEW_SECONDS) throw new ImportedEditError('expired');
  const previewDigest = await treeDigest(preview.files, baseCommitSha);
  if (preview.digest !== previewDigest) throw new ImportedEditError('approval-digest-mismatch');
  const digest = await artifactDigest(preview.files);
  const rows = normalizeChanged(changed);
  for (const row of rows) {
    const file = preview.files.find(item => item.path === row.path.slice('public/'.length));
    if (!file || await sha256Bytes(file.bytes) !== row.afterSha256) throw new ImportedEditError('approval-digest-mismatch');
  }
  const body = {
    v: 1,
    approvalId,
    proposalDigest,
    repositoryId,
    owner: owner ? { provider: owner.provider, id: owner.id } : { provider: 'github', id: String(githubUserId) },
    baseCommitSha: baseCommitSha.toLowerCase(),
    changed: rows,
    artifactDigest: digest,
    previewUrl: preview.origin,
    expiresAt,
    ownerLogin,
    repository,
    explicitlyApproved: true
  };
  return { ...body, digest: await sha256Text(jcs(approvalBody(body))) };
}
