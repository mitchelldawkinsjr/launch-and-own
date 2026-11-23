// #39 / GPT-6: pure, read-only regular-file tree preflight for reviewed edits.
// This helper is NOT an owner authorization, customer approval, GitHub writer,
// public deployment check or a replacement for #98/#103/#112 evidence.
import {MANAGED_CONFIG_PATH} from './managed-site-config.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const SITE_ID = /^managed_[1-9][0-9]*_[a-z0-9_-]{1,128}$/i;
const HOMEPAGE = 'public/index.html';
const MAX_ENTRIES = 4096;
const MAX_HTML_BYTES = 128 * 1024;
const MAX_SIDECAR_BYTES = 16 * 1024;
const FILE_MODES = new Map([
  ['100644','blob'], ['100755','blob'],
  ['120000','blob'], ['160000','commit'], ['040000','tree']
]);
const utf8 = value => new TextEncoder().encode(value);
const isSha = value => typeof value === 'string' && SHA.test(value);
const isDigest = value => typeof value === 'string' && DIGEST.test(value);
const safeString = value => typeof value === 'string' && value.length > 0;

export class ManagedTreePreflightError extends Error {
  constructor(code) {
    super('Managed website tree preflight unavailable (' + code + ')');
    this.name = 'ManagedTreePreflightError';
    this.code = code;
  }
}
const fail = code => {throw new ManagedTreePreflightError(code);};
function ownKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).length === keys.length &&
    Object.keys(obj).every(key => keys.includes(key));
}
async function digest(content) {
  const bytes = await crypto.subtle.digest('SHA-256', utf8(content));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2,'0')).join('');
}
function snapshot(input) {
  const names = ['currentSource', 'sidecarEvidence', 'reviewPlan',
    'mainBranch', 'pinnedCommit', 'pinnedTree'];
  const originals = names.map(n => input?.[n]);
  let copies, signatures;
  try {
    signatures = originals.map(x => JSON.stringify(x));
    copies = originals.map(x => structuredClone(x));
  } catch { fail('trusted_evidence_required'); }
  if (copies.some(x => x === undefined || x === null))
    fail('trusted_evidence_required');
  const trustedReviewDigest = input?.trustedReviewDigest;
  if (!isDigest(trustedReviewDigest))
    fail('trusted_review_digest_required');
  function unchanged() {
    try {
      if (names.some((n,i) => JSON.stringify(input[n]) !== signatures[i]) ||
          input.trustedReviewDigest !== trustedReviewDigest)
        fail('trusted_evidence_changed');
    } catch { fail('trusted_evidence_changed'); }
  }
  return Object.fromEntries([
    ...names.map((name,i) => [name,copies[i]]),
    ['trustedReviewDigest',trustedReviewDigest.toLowerCase()],
    ['unchanged',unchanged]
  ]);
}
function checkEvidence(data) {
  const {currentSource:src, sidecarEvidence:side,reviewPlan:plan,
    mainBranch:branch,pinnedCommit:commit,pinnedTree:tree,trustedReviewDigest} = data;
  if (src?.status !== 'github_current_source_verified' ||
      !safeString(src.siteId) || src.siteId.length > 128 ||
      !SITE_ID.test(src.siteId) || !isSha(src.baseCommitSha) ||
      !isSha(src.homepageGitBlobSha) || !isDigest(src.homepageHtmlSha256) ||
      src.publicationVerified !== false ||
      src.editMode !== 'approved_migration_required')
    fail('verified_current_source_required');

  if (plan?.status !== 'review_required' ||
      plan.readyForProviderWrite !== false ||
      plan.requiresSeparateHumanApproval !== true ||
      plan.publicationVerified !== false ||
      !isDigest(plan.approvalReviewDigest) ||
      plan.approvalReviewDigest.toLowerCase() !== trustedReviewDigest ||
      !isDigest(plan.proposedHtmlSha256) ||
      !isDigest(plan.proposedSidecarSha256) ||
      plan.source?.siteId !== src.siteId ||
      plan.source?.expectedBaseCommitSha !== src.baseCommitSha ||
      plan.source?.existingHomepageGitBlobSha !== src.homepageGitBlobSha ||
      plan.source?.existingHtmlSha256 !== src.homepageHtmlSha256)
    fail('trusted_review_does_not_match_source');

  if (side?.path !== MANAGED_CONFIG_PATH ||
      side.siteId !== src.siteId || side.refCommitSha !== src.baseCommitSha)
    fail('sidecar_proof_does_not_match_source');

  if (branch?.name !== 'main' ||
      branch.commit?.sha?.toLowerCase() !== src.baseCommitSha.toLowerCase() ||
      commit?.sha?.toLowerCase() !== src.baseCommitSha.toLowerCase() ||
      !isSha(commit.tree?.sha) ||
      !isSha(tree?.sha) ||
      commit.tree.sha.toLowerCase() !== tree.sha.toLowerCase())
    fail('stale_main_or_tree');

  if (tree.truncated !== false || !Array.isArray(tree.tree) ||
      tree.tree.length === 0 || tree.tree.length > MAX_ENTRIES)
    fail('incomplete_or_oversized_tree');

  const isMigration = plan.kind === 'add_sidecar_only';
  const isEdit = plan.kind === 'update_homepage_and_sidecar';
  if (!isMigration && !isEdit) fail('unsupported_review_kind');
  if (!Array.isArray(plan.files) ||
      plan.files.length !== (isMigration ? 1 : 2))
    fail('unexpected_review_file_set');
  const expected = isMigration
    ? [{path:MANAGED_CONFIG_PATH,action:'create',max:MAX_SIDECAR_BYTES}]
    : [{path:HOMEPAGE,action:'replace',max:MAX_HTML_BYTES},
       {path:MANAGED_CONFIG_PATH,action:'replace',max:MAX_SIDECAR_BYTES}];
  for(let i=0;i<expected.length;i++){
    const f=plan.files[i],e=expected[i];
    if (!f || !ownKeys(f,['path','action','content']) ||
        f.path !== e.path || f.action !== e.action ||
        typeof f.content !== 'string' ||
        utf8(f.content).byteLength === 0 ||
        utf8(f.content).byteLength > e.max)
      fail('unexpected_review_file_set');
  }
  if (isMigration) {
    if (side.exists !== false || Object.hasOwn(side,'blobSha') ||
        Object.hasOwn(side,'contentSha256') ||
        plan.existingSidecarGitBlobSha !== null ||
        plan.existingSidecarContentSha256 !== null ||
        plan.proposedHtmlSha256.toLowerCase() !==
        src.homepageHtmlSha256.toLowerCase())
      fail('sidecar_proof_does_not_match_review');
  } else {
    if (side.exists !== true || !isSha(side.blobSha) ||
        !isDigest(side.contentSha256) ||
        plan.existingSidecarGitBlobSha?.toLowerCase() !== side.blobSha.toLowerCase() ||
        plan.existingSidecarContentSha256?.toLowerCase() !==
        side.contentSha256.toLowerCase() ||
        plan.proposedHtmlSha256.toLowerCase() ===
        src.homepageHtmlSha256.toLowerCase())
      fail('sidecar_proof_does_not_match_review');
  }
  return {isMigration, expected};
}
function parseTree(tree) {
  const index = new Map();
  for (const item of tree.tree) {
    const path = item?.path;
    if (!safeString(path) || path.length > 2048 ||
        path.startsWith('/') || path.includes('\\') ||
        path.includes('\u0000') || path.split('/').some(p => !p || p === '.' || p === '..') ||
        !isSha(item.sha) || FILE_MODES.get(item.mode) !== item.type ||
        index.has(path)) fail('unverifiable_tree_entry');
    index.set(path,item);
  }
  return index;
}
function target(index, path, present, expectedSha) {
  const entry = index.get(path);
  if (!present) {
    if (entry || [...index.keys()].some(key => key.startsWith(path+'/')))
      fail('target_path_collision');
    return;
  }
  if (!entry || entry.mode !== '100644' || entry.type !== 'blob')
    fail('expected_regular_file_missing_or_replaced');
  if (!isSha(expectedSha) || entry.sha.toLowerCase() !== expectedSha.toLowerCase())
    fail('expected_file_blob_changed');
  if ([...index.keys()].some(key => key.startsWith(path+'/')))
    fail('target_path_collision');
}
function parent(index,path,required) {
  const entry = index.get(path);
  if (!entry) {
    if (required || [...index.keys()].some(key => key.startsWith(path+'/')))
      fail('expected_directory_missing_or_replaced');
    return;
  }
  if (entry.mode !== '040000' || entry.type !== 'tree')
    fail('target_parent_is_not_directory');
}

/**
 * Pure preflight for a FUTURE separately approved GitHub branch/PR executor.
 * All inputs MUST be from a backend-authenticated, still-current #98/#103/#112
 * read + GitHub GET branch/commit/recursive tree. A caller-supplied browser
 * object or digest does NOT authenticate this function. trustedReviewDigest
 * must come from a server-sealed, same-session review record.
 *
 * This checks file safety only. It does not establish original site provenance,
 * grant write permission, represent customer consent, or verify live publishing.
 */
export async function preflightManagedSiteUpdateTree(input={}) {
  const data=snapshot(input);
  const {currentSource:source,reviewPlan:plan,pinnedTree:tree,
    sidecarEvidence:side,unchanged} = data;
  const {isMigration} = checkEvidence(data);
  const index=parseTree(tree);
  parent(index,'public',true);
  parent(index,'.launch-and-own',false);
  target(index,HOMEPAGE,true,source.homepageGitBlobSha);
  target(index,MANAGED_CONFIG_PATH,!isMigration,side.blobSha);

  if (isMigration) {
    const nextSidecarSha=await digest(plan.files[0].content);
    unchanged();
    if (nextSidecarSha !== plan.proposedSidecarSha256.toLowerCase())
      fail('proposed_sidecar_digest_mismatch');
  } else {
    const newHtmlSha=await digest(plan.files[0].content);
    unchanged();
    if (newHtmlSha !== plan.proposedHtmlSha256.toLowerCase())
      fail('proposed_homepage_digest_mismatch');
    const nextSidecarSha=await digest(plan.files[1].content);
    unchanged();
    if (nextSidecarSha !== plan.proposedSidecarSha256.toLowerCase())
      fail('proposed_sidecar_digest_mismatch');
  }
  unchanged();
  return Object.freeze({
    status:'tree_review_preflight_passed',
    siteId:source.siteId,
    expectedBaseCommitSha:source.baseCommitSha.toLowerCase(),
    expectedTreeSha:tree.sha.toLowerCase(),
    reviewDigest:plan.approvalReviewDigest.toLowerCase(),
    proposedPaths:Object.freeze(plan.files.map(f=>f.path)),
    fileModesChecked:true,fullTreeChecked:true,
    requiresSeparateHumanApproval:true,
    readyForProviderWrite:false,
    publicationVerified:false
  });
}
