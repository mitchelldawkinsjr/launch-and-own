/**
 * Tenant-scoped site inventory + immutable draft/preview store (memory adapter).
 * Create-draft digests are SHA-256 of exact homepage HTML from site/render-site.mjs
 * (same renderer as onboarding one-page previews). Update drafts still digest
 * change JSON until a full post-change artifact can be re-rendered.
 */
import {createHash, randomBytes} from 'node:crypto';
import {
  BridgeContractError, assertOwnedRecord, assertPreparedDraft,
  humanApprovalHandoff
} from './tool-contract.mjs';
import {renderSite} from '../site/render-site.mjs';

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

/** Map bridge site_spec → Worker renderSite input; hash exact UTF-8 HTML bytes. */
export function previewDigestFromSpec(siteSpec) {
  let html;
  try {
    html = renderSite({
      name: siteSpec.name,
      tagline: siteSpec.headline,
      about: siteSpec.about,
      services: siteSpec.services,
      contactEmail: siteSpec.contactEmail || '',
      theme: siteSpec.theme || 'ocean'
    });
  } catch {
    deny('invalid_arguments');
  }
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

export class MemorySiteDraftStore {
  #sites = new Map();
  #drafts = new Map();

  seedSite(scope, {name, status = 'draft'} = {}) {
    if (!scope?.owner) deny('needs_reauthorization');
    const id = newId('site');
    const record = Object.freeze({
      id, ...ownerFields(scope),
      name: name || 'Untitled site',
      status,
      createdAt: 0
    });
    this.#sites.set(id, record);
    return record;
  }

  listSites(scope) {
    if (!scope?.owner) deny('needs_reauthorization');
    return [...this.#sites.values()]
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

  getSite(scope, siteId) {
    const site = this.#sites.get(siteId);
    assertOwnedRecord(site || {subject: ''}, scope);
    return Object.freeze({
      site_id: site.id,
      name: site.name,
      status: site.status
    });
  }

  prepareSite(scope, siteSpec, {nowSeconds, ttlSeconds = 900}) {
    if (!scope?.owner) deny('needs_reauthorization');
    if (!Number.isSafeInteger(nowSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)
      deny('stale_preview');
    const previewSha256 = previewDigestFromSpec(siteSpec);
    const id = newId('draft');
    const draft = Object.freeze({
      id, ...ownerFields(scope),
      state: 'prepared',
      kind: 'create',
      previewSha256,
      siteSpec: Object.freeze({...siteSpec, services: [...siteSpec.services]}),
      expiresAt: nowSeconds + ttlSeconds
    });
    this.#drafts.set(id, draft);
    return Object.freeze({
      draft_id: id,
      preview_sha256: previewSha256,
      expires_at: draft.expiresAt,
      operation: 'create'
    });
  }

  prepareSiteUpdate(scope, {siteId, baseCommitSha, changes}, {
    nowSeconds, currentCommitSha, currentRepositoryId, ttlSeconds = 900
  }) {
    const site = this.#sites.get(siteId);
    assertOwnedRecord(site || {subject: ''}, scope);
    if (!Number.isSafeInteger(currentRepositoryId) || currentRepositoryId < 1)
      deny('stale_source');
    const previewSha256 = createHash('sha256')
      .update(JSON.stringify({siteId, baseCommitSha, changes}))
      .digest('hex');
    const id = newId('draft');
    const draft = Object.freeze({
      id, ...ownerFields(scope),
      state: 'prepared',
      kind: 'update',
      previewSha256,
      baseCommitSha,
      repositoryId: currentRepositoryId,
      siteId,
      changes: Object.freeze({...changes}),
      expiresAt: nowSeconds + ttlSeconds
    });
    // Fence against stale base using the same helper the transport will use.
    assertPreparedDraft(draft, scope, {
      previewSha256, nowSeconds, currentCommitSha, currentRepositoryId
    });
    this.#drafts.set(id, draft);
    return Object.freeze({
      draft_id: id,
      preview_sha256: previewSha256,
      expires_at: draft.expiresAt,
      operation: 'update',
      site_id: siteId
    });
  }

  getExactPreview(scope, draftId, {nowSeconds}) {
    const draft = this.#drafts.get(draftId);
    assertOwnedRecord(draft || {subject: ''}, scope);
    return assertPreparedDraft(draft, scope, {
      previewSha256: draft.previewSha256,
      nowSeconds,
      currentCommitSha: draft.baseCommitSha || 'a'.repeat(40),
      currentRepositoryId: draft.repositoryId || 1
    });
  }

  requestApproval(scope, {draftId, previewSha256, idempotencyKey}, {nowSeconds}) {
    const draft = this.#drafts.get(draftId);
    if (!draft) deny('not_found');
    assertPreparedDraft(draft, scope, {
      previewSha256,
      nowSeconds,
      currentCommitSha: draft.baseCommitSha || 'a'.repeat(40),
      currentRepositoryId: draft.repositoryId || 1
    });
    // Idempotency key is accepted and scoped; durable dedupe is a future D1 concern.
    if (typeof idempotencyKey !== 'string') deny('invalid_arguments');
    return humanApprovalHandoff({
      url: 'https://onboard.360web.cloud/review?draft=' + draftId,
      draftId,
      previewSha256,
      expiresAt: nowSeconds + 10 * 60
    }, scope, {nowSeconds});
  }
}
