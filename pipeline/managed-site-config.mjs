// #39 / GPT-6: review-only one-page structured source for post-retention edits.
// NO provider writes, approvals, hosted routes, adoption or claim of publication.
import {normalizeSite, renderSite} from '../site/render-site.mjs';

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
const ELIGIBLE_PROVENANCE = new Set(['pinned_launch_approval', 'explicit_owner_adoption']);
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
  let site;
  try { site = normalizeSite(input); }
  catch { refuse('site_config_not_canonical'); }
  if (!keysAre(input, SITE_KEYS) ||
      SITE_KEYS.some(key => JSON.stringify(input[key]) !== JSON.stringify(site[key])))
    refuse('site_config_not_canonical');
  return site;
}
const document = (site, htmlSha256) =>
  ({schema: MANAGED_CONFIG_SCHEMA, version: 1, site, htmlSha256});
const canonical = value => JSON.stringify(value, null, 2) + '\n';

// Snapshot ALL input values synchronously before the FIRST await/digest. This
// prevents an async provider/session callback or hash yield from mixing site A
// source with site B sidecar or a newer patch. Reject observed in-flight changes.
function snapshotInputs({currentSource, sidecarEvidence, sidecarRaw, candidateSite, patch,
  eligibilityEvidence, assertGeneratedOnePageEligibility}) {
  let frozen, originals;
  try {
    originals = [currentSource, sidecarEvidence, sidecarRaw, candidateSite, patch,
      eligibilityEvidence];
    frozen = originals.map(value => structuredClone(value));
  } catch { refuse('review_input_unverifiable'); }
  let signatures;
  try { signatures = originals.map(value => JSON.stringify(value)); }
  catch { refuse('review_input_unverifiable'); }
  function assertUnchanged() {
    try {
      if (originals.some((value, i) => JSON.stringify(value) !== signatures[i]))
        refuse('review_input_changed');
    } catch { refuse('review_input_changed'); }
  }
  if (typeof assertGeneratedOnePageEligibility !== 'function')
    refuse('generated_one_page_eligibility_required');
  const [source, evidence, raw, site, editingPatch, eligibility] = frozen;
  return {source, evidence, raw, site, patch: editingPatch, eligibility,
    assertEligibility: assertGeneratedOnePageEligibility, assertUnchanged};
}

function sourceEvidence(source) {
  // Must be obtained from #98 authenticated, SHA-pinned server-side source read.
  if (source?.status !== 'github_current_source_verified' ||
      typeof source.siteId !== 'string' || source.siteId.length > 128 ||
      !SITE_ID.test(source.siteId) ||
      typeof source.baseCommitSha !== 'string' || !SHA.test(source.baseCommitSha) ||
      typeof source.homepageGitBlobSha !== 'string' || !SHA.test(source.homepageGitBlobSha) ||
      typeof source.homepageHtmlSha256 !== 'string' || !DIGEST.test(source.homepageHtmlSha256) ||
      typeof source.html !== 'string' || source.publicationVerified !== false ||
      source.editMode !== 'approved_migration_required')
    refuse('current_source_proof_required');
  const bytes = toBytes(source.html);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_HTML_BYTES)
    refuse('current_source_digest_mismatch');
  return Object.freeze({
    siteId: source.siteId, baseCommitSha: source.baseCommitSha.toLowerCase(),
    homepageGitBlobSha: source.homepageGitBlobSha.toLowerCase(),
    htmlSha256: source.homepageHtmlSha256.toLowerCase(),
    html: source.html
  });
}

function eligibleSource(ctx, source) {
  const e = ctx.eligibility;
  // Eligibility is independent of current ownership: #98 discovers candidates
  // and cannot prove a customer site was generated (not ZIP/multi-page). The
  // callback MUST revalidate authoritative immutable launch/adoption provenance
  // for this exact current owner/site/ref; these literals are NOT credentials.
  if (!e || e.siteId !== source.siteId ||
      e.baseCommitSha !== source.baseCommitSha ||
      e.homepageGitBlobSha !== source.homepageGitBlobSha ||
      e.sourceKind !== 'generated' || e.layout !== 'one-page' ||
      !ELIGIBLE_PROVENANCE.has(e.provenance))
    refuse('generated_one_page_eligibility_required');
  return Object.freeze({
    siteId: source.siteId, baseCommitSha: source.baseCommitSha,
    homepageGitBlobSha: source.homepageGitBlobSha,
    sourceKind: 'generated', layout: 'one-page', provenance: e.provenance
  });
}
async function checkEligibility(ctx, eligible) {
  let authorized;
  try { authorized = await ctx.assertEligibility(eligible); }
  catch { refuse('generated_one_page_eligibility_required'); }
  ctx.assertUnchanged();
  if (authorized !== true) refuse('generated_one_page_eligibility_required');
}
async function verifiedSource(ctx) {
  const source = sourceEvidence(ctx.source);
  const eligibility = eligibleSource(ctx, source);
  // Call before source hashing AND again before returning any proposal. The
  // caller must do the backend D1 epoch + trusted provenance recheck.
  await checkEligibility(ctx, eligibility);
  const actual = await sha256(toBytes(source.html));
  ctx.assertUnchanged();
  if (actual !== source.htmlSha256) refuse('current_source_digest_mismatch');
  return {source, eligibility};
}
function exactFileEvidence(evidence, source, exists) {
  if (evidence?.path !== MANAGED_CONFIG_PATH ||
      evidence?.siteId !== source.siteId ||
      evidence?.exists !== exists ||
      typeof evidence.refCommitSha !== 'string' ||
      evidence.refCommitSha.toLowerCase() !== source.baseCommitSha)
    refuse('pinned_sidecar_evidence_required');
  if (exists && (typeof evidence.blobSha !== 'string' || !SHA.test(evidence.blobSha) ||
      typeof evidence.contentSha256 !== 'string' || !DIGEST.test(evidence.contentSha256)))
    refuse('pinned_sidecar_evidence_required');
  if (!exists && (Object.hasOwn(evidence, 'blobSha') ||
      Object.hasOwn(evidence, 'contentSha256')))
    refuse('pinned_sidecar_evidence_required');
}
async function parsePinnedSidecar(ctx, source) {
  const raw = ctx.raw, evidence = ctx.evidence;
  exactFileEvidence(evidence, source, true);
  if (typeof raw !== 'string' || toBytes(raw).byteLength > MAX_CONFIG_BYTES)
    refuse('sidecar_unverifiable');
  const rawDigest = await sha256(toBytes(raw));
  ctx.assertUnchanged();
  if (rawDigest !== evidence.contentSha256.toLowerCase())
    refuse('sidecar_bytes_do_not_match_evidence');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { refuse('sidecar_unverifiable'); }
  if (!keysAre(parsed, DOC_KEYS) ||
      parsed.schema !== MANAGED_CONFIG_SCHEMA || parsed.version !== 1 ||
      typeof parsed.htmlSha256 !== 'string' || !DIGEST.test(parsed.htmlSha256))
    refuse('sidecar_unverifiable');
  const site = safeSite(parsed.site);
  // Schema-defined key order, NOT reserialized parsed-input insertion order.
  if (raw !== canonical(document(site, parsed.htmlSha256)))
    refuse('sidecar_unverifiable');
  const actual = await sha256(toBytes(renderSite(site)));
  ctx.assertUnchanged();
  if (parsed.htmlSha256 !== source.htmlSha256 || actual !== source.htmlSha256)
    refuse('sidecar_does_not_match_current_html');
  return {site, blobSha: evidence.blobSha.toLowerCase(), rawSha256: rawDigest};
}
async function reviewDigest(kind, source, provenance, oldSidecarSha, oldSidecarDigest,
  nextHtmlSha, nextSidecarSha) {
  const stable = [
    'launch-and-own/review-only-site-config/v2', kind, source.siteId,
    source.baseCommitSha, source.homepageGitBlobSha, source.htmlSha256,
    provenance, oldSidecarSha, oldSidecarDigest,
    nextHtmlSha, nextSidecarSha, MANAGED_CONFIG_PATH
  ];
  return sha256(toBytes(JSON.stringify(stable)));
}
async function safeReview(ctx, kind, source, eligibility, existing,
  outputHtml, nextSidecar) {
  const nextHtmlSha = await sha256(toBytes(outputHtml));
  ctx.assertUnchanged();
  const nextSidecarSha = await sha256(toBytes(nextSidecar));
  ctx.assertUnchanged();
  const digest = await reviewDigest(kind, source, eligibility.provenance,
    existing?.blobSha ?? null, existing?.rawSha256 ?? null,
    nextHtmlSha, nextSidecarSha);
  ctx.assertUnchanged();
  await checkEligibility(ctx, eligibility);
  const migration = kind === 'add_sidecar_only';
  return {
    status: 'review_required', kind,
    source: {siteId: source.siteId, expectedBaseCommitSha: source.baseCommitSha,
      existingHtmlSha256: source.htmlSha256,
      existingHomepageGitBlobSha: source.homepageGitBlobSha},
    proposedHtmlSha256: nextHtmlSha,
    proposedSidecarSha256: nextSidecarSha,
    existingSidecarGitBlobSha: existing?.blobSha ?? null,
    existingSidecarContentSha256: existing?.rawSha256 ?? null,
    approvalReviewDigest: digest,
    requiresSeparateHumanApproval: true, readyForProviderWrite: false,
    files: migration ?
      [{path: MANAGED_CONFIG_PATH, action: 'create', content: nextSidecar}] :
      [{path: 'public/index.html', action: 'replace', content: outputHtml},
        {path: MANAGED_CONFIG_PATH, action: 'replace', content: nextSidecar}],
    publicationVerified: false
  };
}

/**
 * Legacy migration is sidecar-only and ONLY for a server-verified generated
 * one-page site whose fields reproduce exact, already-published GitHub bytes.
 * The caller supplies current source, absence proof and generated provenance
 * from the same backend authorization epoch. No provider mutations.
 */
export async function planManagedSiteSidecarMigration(input = {}) {
  const ctx = snapshotInputs(input);
  const {source, eligibility} = await verifiedSource(ctx);
  exactFileEvidence(ctx.evidence, source, false);
  let site;
  try { site = normalizeSite(ctx.site); }
  catch { refuse('site_fields_invalid'); }
  const html = renderSite(site);
  const digest = await sha256(toBytes(html));
  ctx.assertUnchanged();
  if (digest !== source.htmlSha256)
    refuse('legacy_html_not_exactly_reproducible');
  const body = canonical(document(site, source.htmlSha256));
  if (toBytes(body).length > MAX_CONFIG_BYTES) refuse('sidecar_too_large');
  return safeReview(ctx, 'add_sidecar_only', source, eligibility, null, source.html, body);
}

/**
 * Subsequent edits use canonical sidecar at the CURRENT main SHA and preserve
 * all untouched fields. Client patches are *not* consent or authorization.
 */
export async function planManagedSiteStructuredEdit(input = {}) {
  const ctx = snapshotInputs(input);
  const {source, eligibility} = await verifiedSource(ctx);
  const existing = await parsePinnedSidecar(ctx, source);
  const patch = ctx.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      !Object.keys(patch).every(key => EDITABLE.has(key)))
    refuse('editable_patch_invalid');
  let nextSite;
  try { nextSite = normalizeSite({...existing.site, ...patch}); }
  catch { refuse('editable_patch_invalid'); }
  const nextHtml = renderSite(nextSite);
  const nextHtmlSha = await sha256(toBytes(nextHtml));
  ctx.assertUnchanged();
  if (nextHtmlSha === source.htmlSha256) {
    await checkEligibility(ctx, eligibility);
    return {status: 'already_current', source: {
      siteId: source.siteId, expectedBaseCommitSha: source.baseCommitSha,
      existingHtmlSha256: source.htmlSha256},
      files: [], requiresSeparateHumanApproval: true, readyForProviderWrite: false};
  }
  const nextSidecar = canonical(document(nextSite, nextHtmlSha));
  if (toBytes(nextSidecar).length > MAX_CONFIG_BYTES) refuse('sidecar_too_large');
  return safeReview(ctx, 'update_homepage_and_sidecar', source,
    eligibility, existing, nextHtml, nextSidecar);
}
