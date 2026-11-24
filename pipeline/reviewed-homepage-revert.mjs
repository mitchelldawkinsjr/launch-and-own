// #86 / GPT-6: review-only plan to restore the previous homepage via an owner-approved Git PR.
// No provider calls, GitHub writes, Cloudflare rollback or deployment claims.
const SHA = /^[a-f0-9]{40}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const PATH = 'public/index.html';
const MANAGED_CONFIG = '.launch-and-own/site-config.json';
const MODES = new Map([
  ['040000','tree'], ['100644','blob'], ['100755','blob'],
  ['120000','blob'], ['160000','commit']
]);
const encoder = new TextEncoder();
const bytes = text => encoder.encode(text);
const hex = buf => Array.from(new Uint8Array(buf),n=>n.toString(16).padStart(2,'0')).join('');
const hash = async (algorithm, input) => hex(await crypto.subtle.digest(algorithm,input));
const sha = value => typeof value === 'string' && SHA.test(value);

export class HomepageRevertReviewError extends Error {
  constructor(code) {
    super('Homepage revert review blocked (' + code + ')');
    this.name = 'HomepageRevertReviewError';
    this.code = code;
  }
}
function fail(code) { throw new HomepageRevertReviewError(code); }

function capture(input) {
  const fields = ['trustedSite','sourceKind','currentBranch','currentCommit','parentCommit',
    'currentTree','parentTree','currentHomepage','parentHomepage'];
  const originals = fields.map(key=>{
    try { return JSON.stringify(input[key]); }
    catch { fail('invalid_trusted_evidence'); }
  });
  if (originals.some(value=>value===undefined)) fail('missing_trusted_evidence');
  let snapshot;
  try { snapshot = structuredClone(Object.fromEntries(fields.map(key=>[key,input[key]]))); }
  catch { fail('invalid_trusted_evidence'); }
  return {
    ...snapshot,
    unchanged() {
      try {
        if(fields.some((field,i)=>JSON.stringify(input[field])!==originals[i]))
          fail('evidence_changed_during_review');
      } catch { fail('evidence_changed_during_review'); }
    }
  };
}
function validSite(s) {
  if (!s || !Number.isSafeInteger(s.githubUserId) || s.githubUserId < 1 ||
      !Number.isSafeInteger(s.githubRepositoryId) || s.githubRepositoryId < 1 ||
      typeof s.cloudflareAccountId !== 'string' || !ACCOUNT.test(s.cloudflareAccountId) ||
      typeof s.pagesProjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(s.pagesProjectId) ||
      !/^[a-z0-9][a-z0-9-]{0,57}$/.test(s.pagesProjectName || '') ||
      s.branch !== 'main' || !sha(s.expectedMainSha))
    fail('verified_owned_site_required');
}
function validateCommitChain(data) {
  const {trustedSite:s,currentBranch:branch,currentCommit:head,parentCommit:previous,
    currentTree:headTree,parentTree:previousTree} = data;
  if (branch?.name !== 'main' || branch.commit?.sha !== s.expectedMainSha ||
      head?.sha !== s.expectedMainSha || !Array.isArray(head.parents) ||
      head.parents.length !== 1 || !sha(head.parents[0]?.sha) ||
      previous?.sha !== head.parents[0].sha ||
      !sha(head.tree?.sha) || !sha(previous.tree?.sha) ||
      headTree?.sha !== head.tree.sha || previousTree?.sha !== previous.tree.sha ||
      head.sha === previous.sha)
    fail('stale_or_unsupported_commit_chain');
}
function parseTree(tree) {
  if (!tree || tree.truncated !== false || !sha(tree.sha) ||
      !Array.isArray(tree.tree) || tree.tree.length < 2 || tree.tree.length > 4096)
    fail('unverifiable_git_tree');
  const map = new Map();
  for (const row of tree.tree) {
    const path = row?.path;
    if (typeof path !== 'string' || !path || path.length > 2048 ||
        path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some(s=>!s || s==='.' || s==='..') ||
        !sha(row.sha) || MODES.get(row.mode) !== row.type ||
        map.has(path.toLowerCase()))
      fail('invalid_or_duplicate_tree_entry');
    map.set(path.toLowerCase(),row);
  }
  const home = map.get(PATH);
  const dir = map.get('public');
  if (!dir || dir.path !== 'public' || dir.mode !== '040000' || dir.type !== 'tree' ||
      !home || home.path !== PATH || home.mode !== '100644' || home.type !== 'blob')
    fail('homepage_not_regular_file');
  if ([...map.keys()].some(p=>p.startsWith(PATH+'/')))
    fail('homepage_path_collision');
  if (map.has(MANAGED_CONFIG))
    fail('managed_sidecar_requires_coordinated_update');
  // One-page only: a multi-page bundle or custom HTML needs a different restore plan.
  if ([...map.values()].some(row=>row.type==='blob' &&
      /^public\/.*\.html?$/i.test(row.path) && row.path!==PATH))
    fail('other_html_requires_multi_page_review');
  return map;
}
function onlyHomepageChanged(current,prior) {
  if (current.size !== prior.size) fail('other_files_changed');
  for (const [key,item] of current) {
    const before = prior.get(key);
    if (!before || item.path !== before.path ||
        item.mode !== before.mode || item.type !== before.type ||
        (key!==PATH && key!=='public' && item.sha !== before.sha))
      fail('other_files_changed');
  }
  if (current.get(PATH).sha === prior.get(PATH).sha)
    fail('no_homepage_change_to_revert');
}
export async function gitBlobSha(content) {
  const body = bytes(content);
  const prefix = bytes('blob '+body.byteLength+'\0');
  const packed = new Uint8Array(prefix.byteLength+body.byteLength);
  packed.set(prefix);
  packed.set(body,prefix.byteLength);
  return hash('SHA-1',packed);
}
async function validatePinnedPage(pinned,tree) {
  if (!pinned || pinned.path!==PATH || typeof pinned.content!=='string' ||
      !sha(pinned.gitBlobSha) || bytes(pinned.content).byteLength<1 ||
      bytes(pinned.content).byteLength>128*1024)
    fail('exact_pinned_homepage_required');
  const observed = await gitBlobSha(pinned.content);
  if (observed!==pinned.gitBlobSha.toLowerCase() ||
      observed!==tree.get(PATH).sha.toLowerCase())
    fail('homepage_blob_does_not_match_git_tree');
  return {
    gitBlobSha: observed,
    htmlSha256: await hash('SHA-256',bytes(pinned.content)),
    content: pinned.content
  };
}
function safeContext(data) {
  const s = data.trustedSite;
  return Object.freeze({
    githubUserId:s.githubUserId,githubRepositoryId:s.githubRepositoryId,
    cloudflareAccountId:s.cloudflareAccountId,pagesProjectId:s.pagesProjectId,
    pagesProjectName:s.pagesProjectName,expectedMainSha:s.expectedMainSha,
    restoreFromCommitSha:data.parentCommit.sha,
    sourceKind:data.sourceKind
  });
}
/**
 * Returns a private, immutable, content-bound REVIEW ONLY plan.
 * Both callback implementations MUST be backend-supplied, returning exactly true
 * only if current connected provider identity, selected site, session/grant epoch
 * AND generated-one-page provenance remain valid. The caller MUST derive GitHub
 * data from authenticated immutable commit/tree/blob GETs, not browser fields.
 *
 * Never treat this plan as a Git write grant or claim that restoring previous
 * Git bytes has rolled back a live Cloudflare deployment.
 */
export async function buildReviewedHomepageRevert(input={}) {
  if(typeof input.assertCurrentAuthorization!=='function' ||
     typeof input.assertGeneratedOnePageEligibility!=='function')
    fail('live_authorization_and_provenance_required');
  const data=capture(input);
  validSite(data.trustedSite);
  if (data.sourceKind !== 'generated-one-page')
    fail('only_generated_one_page_supported');
  validateCommitChain(data);
  const current=parseTree(data.currentTree);
  const previous=parseTree(data.parentTree);
  onlyHomepageChanged(current,previous);
  const context=safeContext(data);
  async function recheck() {
    let auth, provenance;
    try {
      auth=await input.assertCurrentAuthorization(context);
      provenance=auth===true ? await input.assertGeneratedOnePageEligibility(context) : false;
    } catch { fail('authorization_or_provenance_revoked'); }
    data.unchanged();
    if(auth!==true || provenance!==true)
      fail('authorization_or_provenance_revoked');
  }
  await recheck();
  const currentHtml=await validatePinnedPage(data.currentHomepage,current);
  data.unchanged();
  const restoreHtml=await validatePinnedPage(data.parentHomepage,previous);
  data.unchanged();
  if (currentHtml.htmlSha256===restoreHtml.htmlSha256)
    fail('no_homepage_change_to_revert');
  const signature=JSON.stringify([
    'launch-and-own/one-page-reviewed-git-revert/v1',
    context.githubUserId,context.githubRepositoryId,
    context.cloudflareAccountId,context.pagesProjectId,context.pagesProjectName,
    context.expectedMainSha,context.restoreFromCommitSha,
    data.currentTree.sha,data.parentTree.sha,
    PATH,currentHtml.gitBlobSha,currentHtml.htmlSha256,
    restoreHtml.gitBlobSha,restoreHtml.htmlSha256
  ]);
  const approvalReviewDigest=await hash('SHA-256',bytes(signature));
  data.unchanged();
  await recheck();
  return Object.freeze({
    status:'review_required',
    kind:'restore_previous_homepage_via_git_pr',
    source:Object.freeze({
      ...context,currentHomepageGitBlobSha:currentHtml.gitBlobSha,
      currentHomepageSha256:currentHtml.htmlSha256
    }),
    approvalReviewDigest,
    files:Object.freeze([Object.freeze({
      path:PATH,action:'review-replace',
      expectedGitBlobSha:currentHtml.gitBlobSha,
      beforeSha256:currentHtml.htmlSha256,
      afterSha256:restoreHtml.htmlSha256,
      content:restoreHtml.content
    })]),
    requiresSeparateOwnerApproval:true,
    requiresSameRepositoryPr:true,
    requiresManualMerge:true,
    requiresIndependentPostMergeVerification:true,
    readyForProviderWrite:false,
    publicationVerified:false,
    previewProtectionVerified:false,
    previousDeploymentRestored:false
  });
}
