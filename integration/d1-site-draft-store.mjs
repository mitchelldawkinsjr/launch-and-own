/**
 * D1-backed site inventory + draft/preview store for the MCP bridge.
 * Create digests use previewDigestFromSpec (exact renderSite HTML SHA-256).
 */
import {createHash, randomBytes} from 'node:crypto';
import {
  BridgeContractError, assertOwnedRecord, assertPreparedDraft,
  humanApprovalHandoff
} from './tool-contract.mjs';
import {previewDigestFromSpec} from './site-draft-store.mjs';
import {d1All, d1First, d1Run} from './d1-support.mjs';

const deny = code => { throw new BridgeContractError(code); };

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

function rowToSite(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    subject: row.subject,
    githubUserId: row.github_user_id,
    cloudflareAccountId: String(row.cloudflare_account_id).toLowerCase(),
    authorizationEpoch: row.authorization_epoch,
    name: row.name,
    status: row.status,
    createdAt: row.created_at
  });
}

function rowToDraft(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    subject: row.subject,
    githubUserId: row.github_user_id,
    cloudflareAccountId: String(row.cloudflare_account_id).toLowerCase(),
    authorizationEpoch: row.authorization_epoch,
    state: row.state,
    kind: row.kind,
    previewSha256: row.preview_sha256,
    siteSpec: row.site_spec_json ? JSON.parse(row.site_spec_json) : undefined,
    changes: row.changes_json ? JSON.parse(row.changes_json) : undefined,
    siteId: row.site_id || undefined,
    baseCommitSha: row.base_commit_sha || undefined,
    repositoryId: row.repository_id || undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  });
}

export class D1SiteDraftStore {
  constructor(db) {
    this.db = db;
  }

  async seedSite(scope, {name, status = 'draft'} = {}) {
    if (!scope?.owner) deny('needs_reauthorization');
    const id = newId('site');
    const owner = ownerFields(scope);
    const createdAt = 0;
    await d1Run(this.db, `
      INSERT INTO bridge_sites (
        id, subject, github_user_id, cloudflare_account_id, authorization_epoch,
        name, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, owner.subject, owner.githubUserId, owner.cloudflareAccountId,
    owner.authorizationEpoch, name || 'Untitled site', status, createdAt);
    return Object.freeze({
      id, ...owner, name: name || 'Untitled site', status, createdAt
    });
  }

  async listSites(scope) {
    if (!scope?.owner) deny('needs_reauthorization');
    const rows = await d1All(this.db, `
      SELECT * FROM bridge_sites
      WHERE subject = ? AND github_user_id = ? AND cloudflare_account_id = ?
        AND authorization_epoch = ?`,
    scope.subject, scope.owner.githubUserId, scope.owner.cloudflareAccountId,
    scope.owner.authorizationEpoch);
    return rows
      .map(rowToSite)
      .filter(site => {
        try {
          assertOwnedRecord(site, scope);
          return true;
        } catch {
          return false;
        }
      })
      .map(site => Object.freeze({
        site_id: site.id,
        name: site.name,
        status: site.status
      }));
  }

  async getSite(scope, siteId) {
    const site = rowToSite(await d1First(this.db,
      `SELECT * FROM bridge_sites WHERE id = ?`, siteId));
    assertOwnedRecord(site || {subject: ''}, scope);
    return Object.freeze({
      site_id: site.id,
      name: site.name,
      status: site.status
    });
  }

  async prepareSite(scope, siteSpec, {nowSeconds, ttlSeconds = 900}) {
    if (!scope?.owner) deny('needs_reauthorization');
    if (!Number.isSafeInteger(nowSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)
      deny('stale_preview');
    const previewSha256 = previewDigestFromSpec(siteSpec);
    const id = newId('draft');
    const owner = ownerFields(scope);
    const expiresAt = nowSeconds + ttlSeconds;
    const frozenSpec = {...siteSpec, services: [...siteSpec.services]};
    await d1Run(this.db, `
      INSERT INTO bridge_drafts (
        id, subject, github_user_id, cloudflare_account_id, authorization_epoch,
        state, kind, preview_sha256, site_spec_json, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', 'create', ?, ?, ?, ?)`,
    id, owner.subject, owner.githubUserId, owner.cloudflareAccountId,
    owner.authorizationEpoch, previewSha256, JSON.stringify(frozenSpec),
    expiresAt, nowSeconds);
    return Object.freeze({
      draft_id: id,
      preview_sha256: previewSha256,
      expires_at: expiresAt,
      operation: 'create'
    });
  }

  async prepareSiteUpdate(scope, {siteId, baseCommitSha, changes}, {
    nowSeconds, currentCommitSha, currentRepositoryId, ttlSeconds = 900
  }) {
    const site = rowToSite(await d1First(this.db,
      `SELECT * FROM bridge_sites WHERE id = ?`, siteId));
    assertOwnedRecord(site || {subject: ''}, scope);
    if (!Number.isSafeInteger(currentRepositoryId) || currentRepositoryId < 1)
      deny('stale_source');
    const previewSha256 = createHash('sha256')
      .update(JSON.stringify({siteId, baseCommitSha, changes}))
      .digest('hex');
    const id = newId('draft');
    const owner = ownerFields(scope);
    const expiresAt = nowSeconds + ttlSeconds;
    const draft = Object.freeze({
      id, ...owner,
      state: 'prepared',
      kind: 'update',
      previewSha256,
      baseCommitSha,
      repositoryId: currentRepositoryId,
      siteId,
      changes: Object.freeze({...changes}),
      expiresAt
    });
    assertPreparedDraft(draft, scope, {
      previewSha256, nowSeconds, currentCommitSha, currentRepositoryId
    });
    await d1Run(this.db, `
      INSERT INTO bridge_drafts (
        id, subject, github_user_id, cloudflare_account_id, authorization_epoch,
        state, kind, preview_sha256, changes_json, site_id, base_commit_sha,
        repository_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', 'update', ?, ?, ?, ?, ?, ?, ?)`,
    id, owner.subject, owner.githubUserId, owner.cloudflareAccountId,
    owner.authorizationEpoch, previewSha256, JSON.stringify(changes),
    siteId, baseCommitSha, currentRepositoryId, expiresAt, nowSeconds);
    return Object.freeze({
      draft_id: id,
      preview_sha256: previewSha256,
      expires_at: expiresAt,
      operation: 'update',
      site_id: siteId
    });
  }

  /** Unscoped read for the sealed onboarding handoff; callers fence ownership. */
  async getDraftRecord(draftId) {
    return rowToDraft(await d1First(this.db, `SELECT * FROM bridge_drafts WHERE id = ?`, draftId));
  }

  async getExactPreview(scope, draftId, {nowSeconds}) {
    const draft = rowToDraft(await d1First(this.db,
      `SELECT * FROM bridge_drafts WHERE id = ?`, draftId));
    assertOwnedRecord(draft || {subject: ''}, scope);
    const checked = assertPreparedDraft(draft, scope, {
      previewSha256: draft.previewSha256,
      nowSeconds,
      currentCommitSha: draft.baseCommitSha || 'a'.repeat(40),
      currentRepositoryId: draft.repositoryId || 1
    });
    // The owner sees the exact rendered page on the hosted review screen.
    return draft.kind === 'create' ?
      Object.freeze({...checked, review_url: 'https://onboard.360web.cloud/review?draft=' + draft.id}) :
      checked;
  }

  async requestApproval(scope, {draftId, previewSha256, idempotencyKey}, {nowSeconds}) {
    const draft = rowToDraft(await d1First(this.db,
      `SELECT * FROM bridge_drafts WHERE id = ?`, draftId));
    if (!draft) deny('not_found');
    assertPreparedDraft(draft, scope, {
      previewSha256,
      nowSeconds,
      currentCommitSha: draft.baseCommitSha || 'a'.repeat(40),
      currentRepositoryId: draft.repositoryId || 1
    });
    if (typeof idempotencyKey !== 'string') deny('invalid_arguments');
    await d1Run(this.db, `
      INSERT OR IGNORE INTO bridge_approval_idempotency (
        subject, draft_id, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?)`,
    scope.subject, draftId, idempotencyKey, nowSeconds);
    return humanApprovalHandoff({
      url: 'https://onboard.360web.cloud/review?draft=' + draftId,
      draftId,
      previewSha256,
      expiresAt: nowSeconds + 10 * 60
    }, scope, {nowSeconds});
  }
}
