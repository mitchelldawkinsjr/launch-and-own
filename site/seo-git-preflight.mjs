// #88 / GPT-6: verify a separately approved SEO proposal against an immutable Git tree.
// Pure read/validation; this is NOT a GitHub writer or a grant to publish.
import {buildSeoReviewProposal} from './seo-review-proposal.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const MAX_TREE_ENTRIES = 4096;
const MAX_PAGE_BYTES = 128 * 1024;
const ALLOWED_MODES = new Map([
  ['100644','blob'], ['100755','blob'], ['120000','blob'],
  ['160000','commit'], ['040000','tree']
]);
const encoder = new TextEncoder();
const isSha = v => typeof v === 'string' && SHA.test(v);
const isDigest = v => typeof v === 'string' && DIGEST.test(v);
const bytes = value => encoder.encode(value);
const toHex = array => Array.from(new Uint8Array(array), v => v.toString(16).padStart(2,'0')).join('');
const hash = async (algorithm, value) => toHex(await crypto.subtle.digest(algorithm,value));

export class SeoGitPreflightError extends Error {
  constructor(code) {
    super('SEO Git preflight blocked (' + code + ')');
    this.name = 'SeoGitPreflightError';
    this.code = code;
  }
}
function fail(code) { throw new SeoGitPreflightError(code); }

function snapshot(input) {
  const keys = ['site','sourceKind','trustedSite','domainEvidence','approvedProposalSha256',
    'reviewProposal','mainBranch','pinnedCommit','pinnedTree','pinnedFiles'];
  const original = keys.map(key => {
    try { return JSON.stringify(input[key]); }
    catch { fail('malformed_trusted_evidence'); }
  });
  if (original.some(x => x === undefined)) fail('missing_trusted_evidence');
  let copy;
  try { copy = structuredClone(Object.fromEntries(keys.map(key => [key,input[key]]))); }
  catch { fail('malformed_trusted_evidence'); }
  return {
    ...copy,
    assertUnchanged() {
      try {
        if (keys.some((key,i) => JSON.stringify(input[key]) !== original[i]))
          fail('evidence_changed_during_review');
      } catch { fail('evidence_changed_during_review'); }
    }
  };
}

function verifyIdentity(site, evidence) {
  if (!site || !Number.isSafeInteger(site.githubUserId) || site.githubUserId < 1 ||
      !Number.isSafeInteger(site.githubRepositoryId) || site.githubRepositoryId < 1 ||
      !ACCOUNT.test(site.cloudflareAccountId || '') ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(site.pagesProjectId || '') ||
      !/^[a-z0-9][a-z0-9-]{0,57}$/.test(site.pagesProjectName || '') ||
      !isSha(site.expectedBaseSha) || site.branch !== 'main')
    fail('verified_site_required');
  // These fields are checked independently by buildSeoReviewProposal as well.
  if (!evidence || evidence.kind !== 'verified-owned-domain' ||
      evidence.githubUserId !== site.githubUserId ||
      evidence.githubRepositoryId !== site.githubRepositoryId ||
      evidence.cloudflareAccountId !== site.cloudflareAccountId ||
      evidence.pagesProjectId !== site.pagesProjectId ||
      evidence.pagesProjectName !== site.pagesProjectName ||
      evidence.sourceSha !== site.expectedBaseSha)
    fail('domain_owner_mismatch');
}

function parseTree(tree) {
  if (!tree || tree.truncated !== false || !isSha(tree.sha) ||
      !Array.isArray(tree.tree) || tree.tree.length === 0 ||
      tree.tree.length > MAX_TREE_ENTRIES)
    fail('incomplete_git_tree');
  const index = new Map();
  for (const item of tree.tree) {
    const path = item?.path;
    if (typeof path !== 'string' || !path || path.length > 2048 ||
        path.startsWith('/') || path.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..') ||
        !isSha(item.sha) || ALLOWED_MODES.get(item.mode) !== item.type ||
        index.has(path.toLowerCase()))
      fail('invalid_or_duplicate_tree_entry');
    index.set(path.toLowerCase(), item);
  }
  return index;
}
function directory(index, path) {
  const item = index.get(path.toLowerCase());
  if (!item || item.path !== path || item.type !== 'tree' || item.mode !== '040000')
    fail('target_parent_not_directory');
}
function target(index, path, present) {
  const parts = path.split('/');
  for (let n=1;n<parts.length;n++) directory(index,parts.slice(0,n).join('/'));
  const found = index.get(path.toLowerCase());
  if (present) {
    if (!found || found.path !== path || found.type !== 'blob' ||
        found.mode !== '100644')
      fail('original_page_not_regular_file');
  } else if (found) {
    fail('seo_control_file_collision');
  }
  if ([...index.keys()].some(key => key.startsWith(path.toLowerCase() + '/')))
    fail('target_path_directory_collision');
  return found;
}

async function gitBlobSha(content) {
  const body = bytes(content);
  const prefix = bytes('blob ' + body.length + '\0');
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix);
  combined.set(body,prefix.length);
  return hash('SHA-1',combined);
}

/**
 * The caller MUST obtain every input (except the explicit owner-authored
 * structured site copy) from its authenticated server/provider session.
 * approvedProposalSha256 MUST come from a distinct stored owner approval,
 * not from a POST field. assertCurrentAuthorization MUST revalidate the
 * current owner/account/grant/session epoch before AND after the async work.
 *
 * This returns a reviewable, content-bound candidate only. Another independently
 * authorized GitHub PR executor + manual merge + live SHA/HTML verification are
 * required before describing any SEO change as published.
 */
export async function preflightApprovedSeoGitChange(input = {}) {
  if (typeof input.assertCurrentAuthorization !== 'function')
    fail('authorization_callback_required');
  const data = snapshot(input);
  const {site,sourceKind,trustedSite,domainEvidence,approvedProposalSha256,
    reviewProposal,mainBranch,pinnedCommit,pinnedTree,pinnedFiles} = data;
  verifyIdentity(trustedSite,domainEvidence);
  if (!isDigest(approvedProposalSha256) ||
      !isDigest(reviewProposal?.proposalSha256) ||
      approvedProposalSha256.toLowerCase() !== reviewProposal.proposalSha256.toLowerCase())
    fail('separate_owner_approval_required');
  if (!['generated-one-page','generated-multi-page'].includes(sourceKind))
    fail('unsupported_source_kind');
  if (mainBranch?.name !== 'main' ||
      mainBranch.commit?.sha?.toLowerCase() !== trustedSite.expectedBaseSha.toLowerCase() ||
      pinnedCommit?.sha?.toLowerCase() !== trustedSite.expectedBaseSha.toLowerCase() ||
      !isSha(pinnedCommit?.tree?.sha) ||
      pinnedCommit.tree.sha.toLowerCase() !== pinnedTree?.sha?.toLowerCase())
    fail('stale_main_or_tree');
  const index = parseTree(pinnedTree);
  const pagePaths = sourceKind === 'generated-one-page'
    ? ['public/index.html'] :
      ['public/index.html','public/about/index.html',
       'public/services/index.html','public/contact/index.html'];
  const files = [...index.values()].filter(item => item.type !== 'tree').map(item => item.path);
  // Generated sites with additional hand-edited HTML are not safely handled by
  // the deterministic renderer or the four-URL sitemap.
  if ([...index.values()].some(item => item.type === 'blob' &&
       /^public\/.*\.html?$/i.test(item.path) && !pagePaths.includes(item.path)))
    fail('unexpected_unreviewed_html');
  if (!Array.isArray(pinnedFiles) || pinnedFiles.length !== pagePaths.length)
    fail('exact_pinned_page_bytes_required');
  for (const path of pagePaths) target(index,path,true);
  for (const path of ['public/robots.txt','public/sitemap.xml']) target(index,path,false);

  if (await input.assertCurrentAuthorization() !== true)
    fail('owner_authorization_revoked');
  const rebuilt = await buildSeoReviewProposal({
    sourceKind,site,trustedSite,domainEvidence,existingPaths:files
  });
  if (rebuilt.status !== 'review-required' ||
      rebuilt.proposalSha256 !== approvedProposalSha256.toLowerCase())
    fail('proposal_stale_or_unverifiable');
  // Never accept a client-edited file list even if it claims the same digest.
  if (JSON.stringify(rebuilt.files) !== JSON.stringify(reviewProposal.files) ||
      rebuilt.canonicalOrigin !== reviewProposal.canonicalOrigin ||
      rebuilt.expectedBaseSha !== reviewProposal.expectedBaseSha)
    fail('proposed_bytes_changed');
  const inspected = [];
  for (let i=0;i<pagePaths.length;i++) {
    const path = pagePaths[i], pinned = pinnedFiles[i];
    if (!pinned || pinned.path !== path || typeof pinned.content !== 'string' ||
        !isSha(pinned.gitBlobSha) || bytes(pinned.content).length > MAX_PAGE_BYTES)
      fail('exact_pinned_page_bytes_required');
    const entry = index.get(path);
    const actualBlobSha = await gitBlobSha(pinned.content);
    if (entry.sha.toLowerCase() !== actualBlobSha ||
        pinned.gitBlobSha.toLowerCase() !== actualBlobSha ||
        rebuilt.files[i].beforeSha256 !== await hash('SHA-256',bytes(pinned.content)))
      fail('source_bytes_or_git_blob_mismatch');
    inspected.push(Object.freeze({
      path,action:'review-replace',expectedGitBlobSha:actualBlobSha,
      beforeSha256:rebuilt.files[i].beforeSha256,
      afterSha256:rebuilt.files[i].afterSha256,content:rebuilt.files[i].content
    }));
  }
  for (const file of rebuilt.files.slice(pagePaths.length)) {
    if (!['public/robots.txt','public/sitemap.xml'].includes(file.path) ||
        file.action !== 'review-create' || file.beforeSha256 !== null ||
        file.afterSha256 !== await hash('SHA-256',bytes(file.content)))
      fail('unsafe_seo_control_file');
    inspected.push(Object.freeze({
      path:file.path,action:'review-create',expectedGitBlobSha:null,
      beforeSha256:null,afterSha256:file.afterSha256,content:file.content
    }));
  }
  data.assertUnchanged();
  if (await input.assertCurrentAuthorization() !== true)
    fail('owner_authorization_revoked');
  data.assertUnchanged();
  return Object.freeze({
    status:'verified-seo-review-preflight',
    githubRepositoryId:trustedSite.githubRepositoryId,
    cloudflareAccountId:trustedSite.cloudflareAccountId,
    pagesProjectId:trustedSite.pagesProjectId,
    expectedBaseSha:trustedSite.expectedBaseSha,
    canonicalOrigin:rebuilt.canonicalOrigin,
    approvedProposalSha256:rebuilt.proposalSha256,
    files:Object.freeze(inspected),
    ownerApprovalMatched:true,
    readyForProviderWrite:false,
    publicationVerified:false,
    requiresSeparatePrExecution:true,
    requiresManualMerge:true
  });
}
