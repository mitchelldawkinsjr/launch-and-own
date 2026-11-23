// #88 / GPT-6: review-only Cloudflare Pages static redirect artifact.
// Consumes a server-validated, stored opt-in and pinned read-only Git evidence.
// NEVER creates a PR, edits DNS, enables Rules, or claims a redirect is live.
import {buildRedirectOptInReview} from '../pipeline/option-feature-review.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PROJECT = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*-site$/;
const VALID_MODES = new Map([['040000','tree'],['100644','blob'],['100755','blob']]);
const PAGES = Object.freeze({
  'generated-one-page': ['public/index.html'],
  'generated-multi-page': ['public/index.html','public/about/index.html',
    'public/services/index.html','public/contact/index.html']
});
const ROUTES = Object.freeze({
  'generated-one-page': ['/'],
  'generated-multi-page': ['/','/about/','/services/','/contact/']
});
const isSha = value => typeof value === 'string' && SHA.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const hex = bytes => Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2,'0')).join('');
const sha256 = async value => hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));

function deny(status,reason) {
  return Object.freeze({
    status,reason,files:Object.freeze([]),proposalSha256:null,
    publicationVerified:false,readyForProviderWrite:false
  });
}
function sourceIdentity(site) {
  return site && UUID.test(site.jobId || '') && positive(site.githubUserId) &&
    positive(site.githubRepositoryId) && ACCOUNT.test(site.cloudflareAccountId || '') &&
    typeof site.pagesProjectId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(site.pagesProjectId) &&
    PROJECT.test(site.pagesProjectName || '') &&
    isSha(site.expectedBaseSha) && site.branch === 'main';
}
function verifiedOrigin(site,evidence,hostname) {
  if (!evidence || evidence.kind !== 'verified-owned-domain' ||
      evidence.githubUserId !== site.githubUserId ||
      evidence.githubRepositoryId !== site.githubRepositoryId ||
      evidence.cloudflareAccountId !== site.cloudflareAccountId ||
      evidence.pagesProjectId !== site.pagesProjectId ||
      evidence.pagesProjectName !== site.pagesProjectName ||
      evidence.sourceSha !== site.expectedBaseSha ||
      !Number.isSafeInteger(evidence.checkedAt) ||
      !Number.isSafeInteger(evidence.expiresAt)) return false;
  const now=Math.floor(Date.now()/1000);
  if (evidence.checkedAt > now || evidence.expiresAt <= now ||
      evidence.expiresAt - evidence.checkedAt > 86400) return false;
  // No user-controlled redirects to alternate origins/ports/paths.
  return evidence.origin === 'https://' + hostname;
}
function storedOptIn(option,site) {
  if (!option || !UUID.test(option.id || '') ||
      option.jobId !== site.jobId || option.kind !== 'redirects' ||
      option.status !== 'stored' || option.canWrite !== false ||
      option.canActivate !== false || positive(option.githubUserId) === false ||
      option.githubUserId !== site.githubUserId ||
      option.cloudflareAccountId !== site.cloudflareAccountId ||
      !DIGEST.test(option.digest || '')) return null;
  const payload=option.normalizedPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Array.isArray(payload.pathRules) || payload.pathRules.length > 1) return null;
  const actual=buildRedirectOptInReview({
    githubUserId:site.githubUserId,
    cloudflareAccountId:site.cloudflareAccountId,
    hostname:payload.hostname,
    redirectConsent:true, wwwMode:payload.wwwMode,
    pathFrom:payload.pathRules[0]?.from || '',
    pathTo:payload.pathRules[0]?.to || ''
  });
  if (actual.status !== 'awaiting_redirect_opt_in' ||
      actual.approvalDigest !== option.digest ||
      !same(payload,{
        hostname:actual.plan.hostname,wwwMode:actual.plan.proposed.wwwMode,
        pathRules:actual.plan.proposed.pathRules
      })) return null;
  return payload;
}
function safeTree(tree,sourceKind) {
  if (tree?.truncated !== false || !isSha(tree.sha) ||
      !Array.isArray(tree.tree) || tree.tree.length < 2 || tree.tree.length > 4096)
    return null;
  const entries=new Map();
  for (const item of tree.tree) {
    const path=item?.path;
    if (typeof path !== 'string' || !path || path.length > 2048 ||
        path.startsWith('/') || path.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some(part=>!part || part === '.' || part === '..') ||
        !isSha(item.sha) || VALID_MODES.get(item.mode) !== item.type ||
        entries.has(path.toLowerCase())) return null;
    entries.set(path.toLowerCase(),item);
  }
  const directory=entries.get('public');
  if (directory?.path !== 'public' || directory.type !== 'tree' ||
      directory.mode !== '040000') return null;
  for (const path of PAGES[sourceKind]) {
    const e=entries.get(path.toLowerCase());
    if (!e || e.path !== path || e.type !== 'blob' || e.mode !== '100644') return null;
    const parts=path.split('/');
    for (let i=1;i<parts.length;i++) {
      const ancestor=parts.slice(0,i).join('/');
      const parent=entries.get(ancestor);
      if (parent?.path !== ancestor || parent.type !== 'tree' ||
          parent.mode !== '040000') return null;
    }
  }
  if ([...entries.values()].some(e =>
    (e.type === 'blob' && /^public\/.*\.html?$/i.test(e.path) &&
      !PAGES[sourceKind].includes(e.path)) ||
    e.path === 'functions' || e.path.startsWith('functions/') ||
    ['public/_worker.js','public/_routes.json'].includes(e.path.toLowerCase()))) return null;
  if (entries.has('public/_redirects') ||
      [...entries.keys()].some(p=>p.startsWith('public/_redirects/'))) return null;
  return entries;
}
function safeRedirect(sourceKind, payload) {
  if (payload.wwwMode !== 'none') return false;
  const rule=payload.pathRules[0];
  const from=rule?.from, to=rule?.to;
  if (typeof from !== 'string' || typeof to !== 'string' ||
      rule.host !== payload.hostname || rule.status !== 301 ||
      from.length > 200 || to.length > 200 || from === to ||
      !/^\/[a-z0-9._~/-]*$/i.test(from) ||
      !/^\/[a-z0-9._~/-]*$/i.test(to)) return false;
  // Never shadow a site's known canonical page or security/worker endpoints.
  const parts=from.toLowerCase().split('/');
  if (ROUTES[sourceKind].includes(from) || from === '/' ||
      parts.some(x=>x === '.' || x === '..') ||
      ['_redirects','_headers','_routes.json','_worker.js','functions',
        'api','.well-known'].includes(parts[1])) return false;
  // A redirect target must be a known generated route (not a guessed 404).
  return ROUTES[sourceKind].includes(to);
}

/**
 * Produces a new public/_redirects file for owner review only.
 *
 * The caller must read the option from the D1 owner/session-fenced validator,
 * derive trustedSite/domainEvidence and Git main/commit/tree from independently
 * authenticated providers, and re-check auth on both sides of this async work.
 * The output is NOT an execution grant. An exact separately approved PR and
 * post-merge HTTP 301 acceptance are still required before claiming activation.
 */
export async function buildStaticRedirectReviewProposal(input={}) {
  const keys=['sourceKind','storedOption','trustedSite','domainEvidence',
    'mainBranch','pinnedCommit','pinnedTree'];
  let original, data;
  try {
    original=keys.map(key=>JSON.stringify(input[key]));
    if (original.some(x=>x===undefined)) return deny('blocked-missing-evidence',
      'The current stored review and pinned provider evidence are required');
    data=structuredClone(Object.fromEntries(keys.map(key=>[key,input[key]])));
  } catch { return deny('blocked-invalid-evidence','Invalid provider snapshot'); }
  const {sourceKind,storedOption,trustedSite,domainEvidence,mainBranch,
    pinnedCommit,pinnedTree}=data;
  if (!Object.hasOwn(PAGES,sourceKind)) return deny('manual-review-required',
    'Imported ZIP and custom websites must not be rewritten automatically');
  if (!sourceIdentity(trustedSite)) return deny('blocked-site-identity',
    'Current owned site, Git repository and main SHA required');
  const payload=storedOptIn(storedOption,trustedSite);
  if (!payload) return deny('blocked-stored-approval',
    'An exact, current, owner-scoped stored redirect review is required');
  if (!verifiedOrigin(trustedSite,domainEvidence,payload.hostname))
    return deny('blocked-domain-evidence',
      'A fresh, exact Pages domain origin bound to this site is required');
  if (payload.wwwMode !== 'none') return deny('manual-review-required',
    'Apex/www redirects require separately reviewed zone and DNS configuration');
  if (!safeRedirect(sourceKind,payload)) return deny('blocked-unsafe-redirect',
    'Only legacy paths to verified generated routes can be reviewed');
  if (mainBranch?.name !== 'main' || mainBranch.commit?.sha !== trustedSite.expectedBaseSha ||
      pinnedCommit?.sha !== trustedSite.expectedBaseSha ||
      pinnedCommit.tree?.sha !== pinnedTree?.sha || !isSha(pinnedTree?.sha))
    return deny('blocked-stale-source','Pinned Git tree and current main SHA must match');
  if (!safeTree(pinnedTree,sourceKind)) return deny('blocked-tree-collision',
    'Existing redirects, Functions, symlinks, extra HTML or invalid source tree');
  if (typeof input.assertCurrentAuthorization !== 'function')
    return deny('blocked-authorization','A server-side current-owner fence is required');
  let authorized=false;
  try {authorized=await input.assertCurrentAuthorization()===true;}catch {}
  if (!authorized) return deny('blocked-authorization','Owner session was revoked');
  const rule=payload.pathRules[0];
  const content=rule.from+' '+rule.to+' 301\n';
  const afterSha256=await sha256(content);
  const proposalSha256=await sha256(JSON.stringify([
    'launch-and-own-static-redirect-v1',sourceKind,
    storedOption.id,storedOption.digest,trustedSite.jobId,
    trustedSite.githubUserId,trustedSite.githubRepositoryId,
    trustedSite.cloudflareAccountId,trustedSite.pagesProjectId,
    trustedSite.pagesProjectName,trustedSite.expectedBaseSha,
    pinnedTree.sha,domainEvidence.origin,afterSha256
  ]));
  let unchanged=false;
  try {unchanged=keys.every((key,i)=>JSON.stringify(input[key])===original[i]);}
  catch {}
  let stillAuthorized=false;
  try {stillAuthorized=await input.assertCurrentAuthorization()===true;}catch {}
  if (!unchanged || !stillAuthorized ||
      !verifiedOrigin(trustedSite,domainEvidence,payload.hostname))
    return deny('blocked-review-context-changed',
      'The owner, grant, domain or source changed while preparing the review');
  const file=Object.freeze({
    path:'public/_redirects',action:'review-create',
    beforeSha256:null,afterSha256,content
  });
  return Object.freeze({
    status:'review-required',
    reason:'Review the exact new Pages static redirect file before a Git PR',
    files:Object.freeze([file]),proposalSha256,
    expectedBaseSha:trustedSite.expectedBaseSha,
    hostname:payload.hostname,sourceKind,
    publicationVerified:false,requiresOwnerApproval:true,
    requiresVerifiedGitUpdate:true,readyForProviderWrite:false
  });
}
