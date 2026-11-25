import { ImportedEditError } from './errors.mjs';

export function memoryApprovalStore({ now = () => Date.now(), resumeAfterMs = 60_000 } = {}) {
  const byId = new Map();
  const byKey = new Map();
  const keyOf = receipt => receipt.repositoryId + '\0' + receipt.baseCommitSha + '\0' + receipt.artifactDigest;
  return {
    async claim(receipt) {
      const key = keyOf(receipt);
      if (byId.has(receipt.approvalId)) throw new ImportedEditError('approval_consumed');
      const existing = byKey.get(key);
      if (existing) {
        if (existing.owner.provider !== receipt.owner.provider || existing.owner.id !== receipt.owner.id) {
          throw new ImportedEditError('approval_mismatch');
        }
        return { write: false };
      }
      const row = { ...receipt, createdAt: now() };
      byId.set(receipt.approvalId, row);
      byKey.set(key, row);
      return { write: true };
    },
    async resume(receipt) {
      const existing = byKey.get(keyOf(receipt));
      if (!existing || existing.owner.provider !== receipt.owner.provider || existing.owner.id !== receipt.owner.id) return false;
      if (now() - existing.createdAt < resumeAfterMs) return false;
      byId.delete(existing.approvalId);
      existing.approvalId = receipt.approvalId;
      existing.createdAt = now();
      byId.set(receipt.approvalId, existing);
      return true;
    }
  };
}

export function d1ApprovalStore(db) {
  return {
    async claim(receipt) {
      try {
        await db.prepare(`INSERT INTO onboarding_imported_edit_approvals
          (approval_id, repository_id, base_commit_sha, artifact_digest, owner_provider, owner_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          receipt.approvalId, receipt.repositoryId, receipt.baseCommitSha, receipt.artifactDigest,
          receipt.owner.provider, receipt.owner.id, Math.floor(Date.now() / 1000)
        ).run();
        return { write: true };
      } catch (error) {
        if (!/UNIQUE/i.test(String(error?.message || ''))) throw error;
      }
      const row = await db.prepare(`SELECT approval_id, owner_provider, owner_id
        FROM onboarding_imported_edit_approvals
        WHERE repository_id = ? AND base_commit_sha = ? AND artifact_digest = ?`).bind(
        receipt.repositoryId, receipt.baseCommitSha, receipt.artifactDigest
      ).first();
      if (!row || row.approval_id === receipt.approvalId) throw new ImportedEditError('approval_consumed');
      if (row.owner_provider !== receipt.owner.provider || row.owner_id !== receipt.owner.id) {
        throw new ImportedEditError('approval_mismatch');
      }
      return { write: false };
    },
    async resume(receipt) {
      const now = Math.floor(Date.now() / 1000);
      const result = await db.prepare(`UPDATE onboarding_imported_edit_approvals
        SET approval_id = ?, created_at = ?
        WHERE repository_id = ? AND base_commit_sha = ? AND artifact_digest = ?
          AND owner_provider = ? AND owner_id = ? AND pull_number IS NULL AND created_at <= ?`).bind(
        receipt.approvalId, now, receipt.repositoryId, receipt.baseCommitSha, receipt.artifactDigest,
        receipt.owner.provider, receipt.owner.id, now - 60
      ).run();
      return result?.meta?.changes === 1;
    }
  };
}
