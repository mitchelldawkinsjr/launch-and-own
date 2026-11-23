// #39 / GPT-6: review-only one-page structured source for post-retention edits.
// Pure planning: NEVER writes GitHub/Cloudflare, creates a PR, approves consent,
// or treats client/model-provided content as authenticated source.
import { normalizeSite, renderSite } from '../site/render-site.mjs';

export const MANAGED_CONFIG_PATH = '.launch-and-own/site-config.json';
export const MANAGED_CONFIG_SCHEMA = 'launch-and-own/site-config';
const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const SITE_ID = /^managed_[1-9][0-9]*_[a-z0-9_-]{1,128}$/i;
const MAX_HTML_BYTES = 128 * 1024;
const MAX_CONFIG_BYTES = 16 * 1024;
const EDITABLE = new Set(['tagline', 'about', 'services', 'theme', 'contactEmail']);
const SITE_KEYS = ['name', 'tagline', 'about', 'services', 'theme', 'contactEmail'];
const DOC_KEYS = ['schema', 'version', 'site', 'htmlSha256'];
const toBytes = value => new TextEncoder().encode(value);

export class ManagedSiteConfigError extends Error {
  constructor(code) {
    super('Managed website configuration review unavailable (' + code + ')');
    this.name = 'ManagedSiteConfigError';
    this.code = code;
  }
}
function refuse(code) { throw new ManagedSiteConfigError(code); }
async function sha256(bytes) {
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
function keysAre(value, list) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === list.length &&
    Object.keys(value).every(key => list.includes(key));
}
function safeSite(input) {
  try {
    const site = normalizeSite(input);
    if (!keysAre(input, SITE_KEYS) || JSON.stringify(input) !== JSON.stringify(site))
      refuse('site_config_not_canonical');
    return site;
  } catch { refuse('site_config_not_canonical'); }
}
async function verifiedSource(source) {
  // Only the backend's SHA-pinned #98 source read may supply this object.
  if (source?.status !== 'github_current_source_verified' ||
      typeof source.siteId !== 'string' || source.siteId.length > 128 || !SITE_ID.test(source.siteId) ||
      typeof source.baseCommitSha !== 'string' || !SHA.test(source.baseCommitSha) ||
      typeof source.homepageGitBlobSha !== 'string' || !SHA.test(source.homepageGitBlobSha) ||
      typeof source.homepageHtmlSha256 !== 'string' || !DIGEST.test(source.homepageHtmlSha256) ||
      typeof source.html !== 'string' || source.publicationVerified !== false ||
      source.editMode !== 'approved_migration_required')
    refuse('current_source_proof_required');
  const bytes = toBytes(source.html);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_HTML_BYTES ||
      await sha256(bytes) !== source.homepageHtmlSha256.toLowerCase())
    refuse('current_source_digest_mismatch');
  return Object.freeze({
    siteId: source.siteId, baseCommitSha: source.baseCommitSha.toLowerCase(),
    homepageGitBlobSha: source.homepageGitBlobSha.toLowerCase(),
    htmlSha256: source.homepageHtmlSha256.toLowerCase(), html: source.html
  });
}
function exactFileEvidence(evidence, source, exists) {
  if (evidence?.path !== MANAGED_CONFIG_PATH ||
      evidence?.exists !== exists ||
      typeof evidence.refCommitSha !== 'string' ||
      evidence.refCommitSha.toLowerCase() !== source.baseCommitSha)
    refuse('pinned_sidecar_evidence_required');
  if (exists && (typeof evidence.blobSha !== 'string' || !SHA.test(evidence.blobSha)))
    refuse('pinned_sidecar_evidence_required');
  if (!exists && Object.hasOwn(evidence, 'blobSha'))
    refuse('pinned_sidecar_evidence_required');
}
function document(site, htmlSha256) {
  return {schema: MANAGED_CONFIG_SCHEMA, version: 1, site, htmlSha256};
}
const canonical = value => JSON.stringify(value, null, 2) + '\n';
async function reviewDigest(kind, source, oldSidecarSha, nextHtmlSha, nextSidecarSha) {
  const stable = [
    'launch-and-own/review-only-site-config/v1', kind, source.siteId,
    source.baseCommitSha, source.homepageGitBlobSha, source.htmlSha256,
    oldSidecarSha, nextHtmlSha, nextSidecarSha, MANAGED_CONFIG_PATH
  ];
  return sha256(toBytes(JSON.stringify(stable)));
}
function safeReview(kind, source, existingSidecarSha, outputHtml, nextSidecar) {
  return (async () => {
    const nextHtmlSha = await sha256(toBytes(outputHtml));
    const nextSidecarSha = await sha256(toBytes(nextSidecar));
    const digest = await reviewDigest(kind, source, existingSidecarSha,
      nextHtmlSha, nextSidecarSha);
    const migration = kind === 'add_sidecar_only';
    return {
      status: 'review_required', kind,
      source: {siteId: source.siteId, expectedBaseCommitSha: source.baseCommitSha,
        existingHtmlSha256: source.htmlSha256, existingHomepageGitBlobSha: source.homepageGitBlobSha},
      proposedHtmlSha256: nextHtmlSha,
      proposedSidecarSha256: nextSidecarSha,
      existingSidecarGitBlobSha: existingSidecarSha,
      approvalReviewDigest: digest,
      requiresSeparateHumanApproval: true,
      readyForProviderWrite: false,
      files: migration ?
        [{path: MANAGED_CONFIG_PATH, action: 'create', content: nextSidecar}] :
        [{path: 'public/index.html', action: 'replace', content: outputHtml},
          {path: MANAGED_CONFIG_PATH, action: 'replace', content: nextSidecar}],
      // No provider request, automatic branch creation or app release.
      publicationVerified: false
    };
  })();
}
async function parsePinnedSidecar({source, sidecarEvidence, sidecarRaw}) {
  exactFileEvidence(sidecarEvidence, source, true);
  if (typeof sidecarRaw !== 'string' || toBytes(sidecarRaw).byteLength > MAX_CONFIG_BYTES)
    refuse('sidecar_unverifiable');
  let parsed;
  try { parsed = JSON.parse(sidecarRaw); }
  catch { refuse('sidecar_unverifiable'); }
  // Strict canonical round-trip also excludes duplicate JSON keys, unknown keys,
  // noncanonical formatting and prototype-polluting alternative spellings.
  if (!keysAre(parsed, DOC_KEYS) ||
      parsed.schema !== MANAGED_CONFIG_SCHEMA || parsed.version !== 1 ||
      typeof parsed.htmlSha256 !== 'string' || !DIGEST.test(parsed.htmlSha256) ||
      sidecarRaw !== canonical(parsed))
    refuse('sidecar_unverifiable');
  const site = safeSite(parsed.site);
  if (parsed.htmlSha256 !== source.htmlSha256 ||
      await sha256(toBytes(renderSite(site))) !== source.htmlSha256)
    refuse('sidecar_does_not_match_current_html');
  return {site, blobSha: sidecarEvidence.blobSha.toLowerCase()};
}

/**
 * The customer's existing main HTML is not touched. A caller must have
 * independently proven the proposed sidecar path is absent at the same SHA.
 * If the customer-entered config can't recreate exact bytes, STOP: full
 * homepage migration needs a separate explicit review, not this plan.
 */
export async function planManagedSiteSidecarMigration({currentSource, sidecarEvidence,
  candidateSite} = {}) {
  const source = await verifiedSource(currentSource);
  exactFileEvidence(sidecarEvidence, source, false);
  let site;
  try { site = normalizeSite(candidateSite); }
  catch { refuse('site_fields_invalid'); }
  const html = renderSite(site);
  if (await sha256(toBytes(html)) !== source.htmlSha256)
    refuse('legacy_html_not_exactly_reproducible');
  const body = canonical(document(site, source.htmlSha256));
  if (toBytes(body).length > MAX_CONFIG_BYTES) refuse('sidecar_too_large');
  return safeReview('add_sidecar_only', source, null, source.html, body);
}

/**
 * A later edit always starts from a canonical sidecar at the CURRENT main SHA,
 * proves it matches that exact homepage, and merges only explicitly changed
 * fields. It cannot silently revert previously merged fields.
 */
export async function planManagedSiteStructuredEdit({currentSource, sidecarEvidence,
  sidecarRaw, patch} = {}) {
  const source = await verifiedSource(currentSource);
  const existing = await parsePinnedSidecar({source, sidecarEvidence, sidecarRaw});
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      !Object.keys(patch).every(key => EDITABLE.has(key)))
    refuse('editable_patch_invalid');
  let nextSite;
  try { nextSite = normalizeSite({...existing.site, ...patch}); }
  catch { refuse('editable_patch_invalid'); }
  const nextHtml = renderSite(nextSite);
  const nextHtmlSha = await sha256(toBytes(nextHtml));
  if (nextHtmlSha === source.htmlSha256)
    return {status: 'already_current', source: {
      siteId: source.siteId, expectedBaseCommitSha: source.baseCommitSha,
      existingHtmlSha256: source.htmlSha256},
      files: [], requiresSeparateHumanApproval: true, readyForProviderWrite: false};
  const nextSidecar = canonical(document(nextSite, nextHtmlSha));
  if (toBytes(nextSidecar).length > MAX_CONFIG_BYTES) refuse('sidecar_too_large');
  return safeReview('update_homepage_and_sidecar', source, existing.blobSha, nextHtml, nextSidecar);
}
