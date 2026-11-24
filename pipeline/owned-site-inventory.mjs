// #39 / GPT-6: read-only current managed-site discovery and source verification.
// No launch-history dependency, D1 writes, provider mutations, or unverified live claims.
import { matchesApprovedPagesProject } from './approved-pages-project.mjs';
import { isManagedRepositoryDescription } from './managed-site-repository.mjs';
import { responseMatchesBytes } from './verify-site.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const PROJECT = /^(esp-[a-z0-9]+(?:-[a-z0-9]+)*)-site$/;
const OPAQUE = /^[a-z0-9_-]{1,128}$/i;
const GIT_SHA = /^[a-f0-9]{40}$/i;
const NUMERIC = /^[1-9][0-9]*$/;
// Eight provider reads leave room for token renewals and history reads on Workers Free.
const PER_PAGE = 2;
const MAX_PROVIDER_REQUESTS = 8;
const MAX_PAGE_NUMBER = 100;
const MAX_SOURCE_BYTES = 128 * 1024;

export class ManagedSiteInventoryError extends Error {
  constructor(code) {
    super('Current managed-site inventory is unavailable (' + code + ')');
    this.name = 'ManagedSiteInventoryError';
    this.code = code;
  }
}
function denied(code) { throw new ManagedSiteInventoryError(code); }
function id(value) {
  return (typeof value === 'string' || typeof value === 'number') &&
    NUMERIC.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}
function sameId(a, b) { return id(a) && id(b) && String(a) === String(b); }
function ownerSnapshot(principal) {
  if (typeof principal?.githubUserId !== 'number' || !id(principal.githubUserId) ||
      typeof principal.githubLogin !== 'string' || !LOGIN.test(principal.githubLogin) ||
      typeof principal.cloudflareAccountId !== 'string' || !ACCOUNT.test(principal.cloudflareAccountId))
    denied('verified_owner_required');
  return Object.freeze({
    githubUserId: principal.githubUserId,
    githubLogin: principal.githubLogin,
    cloudflareAccountId: principal.cloudflareAccountId
  });
}

function reader({principal, githubAccessToken, cloudflareAccessToken,
  assertCurrentAuthorization, fetchFn = fetch}) {
  const owner = ownerSnapshot(principal);
  if (typeof assertCurrentAuthorization !== 'function')
    denied('authorization_fence_required');
  if (typeof githubAccessToken !== 'string' || !githubAccessToken ||
      typeof cloudflareAccessToken !== 'string' || !cloudflareAccessToken)
    denied('provider_reauthorization_required');
  let requests = 0;

  async function authorized() {
    if (principal?.githubUserId !== owner.githubUserId ||
        principal?.githubLogin !== owner.githubLogin ||
        principal?.cloudflareAccountId !== owner.cloudflareAccountId) denied('authorization_changed');
    try {
      if (await assertCurrentAuthorization(owner) !== true) denied('authorization_changed');
    } catch { denied('authorization_changed'); }
    if (principal?.githubUserId !== owner.githubUserId ||
        principal?.githubLogin !== owner.githubLogin ||
        principal?.cloudflareAccountId !== owner.cloudflareAccountId) denied('authorization_changed');
  }
  async function get(provider, path, {allow404 = false} = {}) {
    await authorized();
    if (++requests > MAX_PROVIDER_REQUESTS) denied('provider_request_budget_exceeded');
    const token = provider === 'github' ? githubAccessToken : cloudflareAccessToken;
    const prefix = provider === 'github' ? 'https://api.github.com' :
      'https://api.cloudflare.com/client/v4';
    let response;
    try {
      response = await fetchFn(prefix + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + token,
          accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json',
          ...(provider === 'github' ? {
            'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own'
          } : {})
        }
      });
    } catch { denied(provider + '_temporarily_unavailable'); }
    await authorized();
    if (response?.status === 401) denied(provider + '_reauthorization_required');
    if (response?.status === 403) {
      if (response.headers?.get('retry-after') ||
          response.headers?.get('x-ratelimit-remaining') === '0')
        denied(provider + '_rate_limited');
      denied(provider + '_permission_denied');
    }
    if (response?.status === 429) denied(provider + '_rate_limited');
    if (response?.status === 404 && allow404) return null;
    if (!response?.ok || response.status >= 300) denied(provider + '_temporarily_unavailable');
    let data;
    try { data = await response.json(); }
    catch { denied(provider + '_unexpected_response'); }
    await authorized();
    if (!data || typeof data !== 'object' || Array.isArray(data))
      denied(provider + '_unexpected_response');
    if (provider === 'cloudflare' && data.success !== true)
      denied('cloudflare_unexpected_response');
    return data;
  }
  return {owner, get, authorized, getRequestCount: () => requests};
}

function exactManagedProject(project, repository, owner) {
  const name = project?.name;
  const match = typeof name === 'string' ? PROJECT.exec(name) : null;
  const repositoryName = match?.[1];
  const config = project?.source?.config;
  if (!repositoryName || !OPAQUE.test(project?.id ?? '') || !id(config?.repo_id) ||
      (config?.owner_id != null && !sameId(config.owner_id, owner.githubUserId)) ||
      !Number.isSafeInteger(repository?.id) || !sameId(config.repo_id, repository.id) ||
      repository.name !== repositoryName || repository.private !== true ||
      repository.default_branch !== 'main' || repository.owner?.id !== owner.githubUserId ||
      repository.owner?.login?.toLowerCase() !== owner.githubLogin.toLowerCase() ||
      !isManagedRepositoryDescription(repository.description, repositoryName.slice(4))) return false;
  return matchesApprovedPagesProject(project, {
    name, projectId: project.id, owner: owner.githubLogin, ownerId: owner.githubUserId,
    repositoryName, repositoryId: repository.id, branch: 'main'
  });
}
function publicCommit(project) {
  const deployment = project?.canonical_deployment;
  const hash = deployment?.deployment_trigger?.metadata?.commit_hash;
  return deployment?.environment === 'production' &&
    deployment.latest_stage?.name === 'deploy' &&
    deployment.latest_stage?.status === 'success' &&
    typeof hash === 'string' && GIT_SHA.test(hash) ? hash.toLowerCase() : null;
}
function makeSiteId(repoId, projectId) {
  const siteId = 'managed_' + repoId + '_' + projectId;
  if (siteId.length > 128) denied('invalid_managed_identity');
  return siteId;
}
function safeSite(owner, repository, project, baseCommitSha) {
  return Object.freeze({
    siteId: makeSiteId(repository.id, project.id),
    githubUserId: owner.githubUserId, githubOwner: owner.githubLogin,
    cloudflareAccountId: owner.cloudflareAccountId,
    repositoryId: repository.id, repositoryName: repository.name,
    pagesProjectId: project.id, pagesProjectName: project.name,
    branch: 'main', productionBranch: 'main', sourceKind: 'managed-existing',
    baseCommitSha, productionCommitSha: publicCommit(project),
    publicationVerified: false, historicalContinuityVerified: false,
    sourceState: 'github_main_verified_publication_unverified',
    repositoryUrl: 'https://github.com/' + owner.githubLogin + '/' + repository.name,
    pagesProjectDashboardUrl: 'https://dash.cloudflare.com/' + owner.cloudflareAccountId +
      '/pages/view/' + project.name
  });
}

function checkedReference(reference, owner, siteId) {
  // The reference MUST be taken from a backend-owned or authenticated, bounded
  // session handoff. A browser-provided reference is not ownership evidence.
  if (typeof siteId !== 'string' ||
      !/^managed_[1-9][0-9]*_[a-z0-9_-]{1,128}$/i.test(siteId))
    denied('invalid_site_selector');
  if (!reference || reference.siteId !== siteId ||
      !sameId(reference.githubUserId, owner.githubUserId) ||
      reference.githubOwner?.toLowerCase() !== owner.githubLogin.toLowerCase() ||
      reference.cloudflareAccountId !== owner.cloudflareAccountId ||
      !Number.isSafeInteger(reference.repositoryId) || !id(reference.repositoryId) ||
      !PROJECT.test(reference.pagesProjectName ?? '') ||
      reference.pagesProjectName !== reference.repositoryName + '-site' ||
      !OPAQUE.test(reference.pagesProjectId ?? '') ||
      reference.branch !== 'main' || reference.productionBranch !== 'main' ||
      reference.sourceKind !== 'managed-existing' ||
      makeSiteId(reference.repositoryId, reference.pagesProjectId) !== siteId)
    denied('owned_site_not_found');
}

async function verifyCurrentSite(read, reference) {
  const {owner, get} = read;
  const root = '/repos/' + encodeURIComponent(owner.githubLogin) +
    '/' + reference.repositoryName;
  const projectPath = '/accounts/' + owner.cloudflareAccountId + '/pages/projects/' +
    reference.pagesProjectName;
  const repository = await get('github', root, {allow404: true});
  if (!repository || repository.id !== reference.repositoryId) denied('owned_site_not_found');
  const page = await get('cloudflare', projectPath, {allow404: true});
  if (!page?.result || page.result.id !== reference.pagesProjectId ||
      !exactManagedProject(page.result, repository, owner)) denied('owned_site_not_found');
  const branch = await get('github', root + '/branches/main', {allow404: true});
  if (!GIT_SHA.test(branch?.commit?.sha ?? '')) denied('current_source_requires_review');
  return {root, projectPath, repository, project: page.result,
    baseCommitSha: branch.commit.sha.toLowerCase()};
}

async function ownedReferenceReader(siteId, reference, options) {
  const read = reader(options);
  const {owner, get} = read;
  checkedReference(reference, owner, siteId);
  const user = await get('github', '/user');
  if (user?.id !== owner.githubUserId ||
      user?.login?.toLowerCase() !== owner.githubLogin.toLowerCase())
    denied('github_owner_mismatch');
  return read;
}

/** Fresh account and repository proof for a single sealed dashboard selection. */
export async function readCurrentManagedSite({siteId, reference, ...options} = {}) {
  const read = await ownedReferenceReader(siteId, reference, options);
  const {repository, project, baseCommitSha} = await verifyCurrentSite(read, reference);
  await read.authorized();
  return safeSite(read.owner, repository, project, baseCommitSha);
}

/**
 * Page-scoped, GET-only discovery. `page` is a selector, NEVER ownership.
 * At most two candidates and eight provider reads per page. Each API GET
 * makes three live authorization checks, leaving room for dashboard history
 * reads and credential refreshes within the Workers Free subrequest budget.
 * Older pages may change between requests: never claim stable full-account
 * coverage or historical continuity from a copied, editable repo marker.
 */
export async function discoverOwnedManagedSites({page = 1, ...options} = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE_NUMBER)
    denied('invalid_inventory_page');
  const read = reader(options);
  const {owner, get, authorized} = read;
  const user = await get('github', '/user');
  if (user?.id !== owner.githubUserId ||
      user?.login?.toLowerCase() !== owner.githubLogin.toLowerCase())
    denied('github_owner_mismatch');
  const root = '/accounts/' + owner.cloudflareAccountId + '/pages/projects';
  const data = await get('cloudflare', root + '?page=' + page + '&per_page=' + PER_PAGE);
  if (!Array.isArray(data.result) || data.result.length > PER_PAGE)
    denied('cloudflare_pagination_unverified');
  const info = data.result_info;
  const emptyAccount = info?.total_pages === 0 && page === 1 &&
    info.page === 1 && data.result.length === 0;
  if (!emptyAccount &&
      (!Number.isSafeInteger(info?.page) || info.page !== page ||
       !Number.isSafeInteger(info.total_pages) || info.total_pages < page ||
       info.total_pages > MAX_PAGE_NUMBER))
    denied('cloudflare_pagination_unverified');

  const results = [], seen = new Set();
  for (const entry of data.result) {
    if (!PROJECT.test(entry?.name ?? '')) continue;
    if (!OPAQUE.test(entry?.id ?? '') || seen.has(entry.name))
      denied('cloudflare_pagination_unverified');
    seen.add(entry.name);
    const projectResult = await get('cloudflare', root + '/' +
      encodeURIComponent(entry.name), {allow404: true});
    if (!projectResult?.result) continue;
    const project = projectResult.result;
    if (project.id !== entry.id || project.name !== entry.name) continue;
    const repoName = entry.name.slice(0, -5);
    const repoRoot = '/repos/' + encodeURIComponent(owner.githubLogin) + '/' + repoName;
    const repository = await get('github', repoRoot, {allow404: true});
    if (!repository || !exactManagedProject(project, repository, owner)) continue;
    const branch = await get('github', repoRoot + '/branches/main', {allow404: true});
    if (!GIT_SHA.test(branch?.commit?.sha ?? '')) continue;
    results.push(safeSite(owner, repository, project, branch.commit.sha.toLowerCase()));
  }
  await authorized();
  const nextPage = page < (info.total_pages || 0) ? page + 1 : null;
  return Object.freeze({
    status: 'fresh_owner_scoped_inventory_page', accountId: owner.cloudflareAccountId,
    coverage: 'single_provider_page', page, pageComplete: true, nextPage,
    sites: Object.freeze(results)
  });
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
function decodeGitHubFile(file) {
  if (file?.type !== 'file' || file.encoding !== 'base64' ||
      typeof file.content !== 'string' || !GIT_SHA.test(file.sha ?? '') ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SOURCE_BYTES)
    denied('current_source_requires_review');
  const encoded = file.content.replace(/\s/g, '');
  if (encoded.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    denied('current_source_requires_review');
  let bytes, html;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, x => x.charCodeAt(0));
    if (bytes.length !== file.size) denied('current_source_requires_review');
    // ignoreBOM:true preserves U+FEFF in the internal representation.
    html = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch { denied('current_source_requires_review'); }
  return {bytes, html};
}

function productionSnapshot(project) {
  const commit = publicCommit(project);
  const id = project.canonical_deployment?.id;
  return commit && typeof id === 'string' && OPAQUE.test(id) ? {id, commit} : null;
}

async function checkPublicHomepage(read, fetchFn, url, bytes) {
  await read.authorized();
  let state = 'public_check_unavailable';
  try {
    const response = await fetchFn(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: {accept: 'text/html', 'cache-control': 'no-cache'}
    });
    if (response.status === 200 && /^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      state = await responseMatchesBytes(response, bytes) ? 'verified_homepage' : 'public_content_differs';
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Provider transport details are unsuitable for the customer projection.
  }
  await read.authorized();
  return state;
}

function publicationProjection(project, baseCommitSha, checked, website, digest, checkedAt) {
  const current = productionSnapshot(project);
  const latest = project.latest_deployment;
  const latestCommit = latest?.deployment_trigger?.metadata?.commit_hash;
  if (!current || current.commit !== baseCommitSha) {
    const failed = latest?.environment === 'production' &&
      typeof latestCommit === 'string' && latestCommit.toLowerCase() === baseCommitSha &&
      latest.latest_stage?.status === 'failure';
    return {state: failed ? 'deployment_failed' : 'waiting_for_current_deployment',
      productionCommitSha: current?.commit ?? null};
  }
  if (!checked || checked.id !== current.id)
    return {state: 'deployment_changed', productionCommitSha: current.commit};
  if (checked.state !== 'verified_homepage')
    return {state: checked.state, productionCommitSha: current.commit};
  return {state: 'verified_homepage', productionCommitSha: current.commit, deploymentId: current.id,
    publicHtmlSha256: digest, verifiedUrl: website, checkedAt};
}

/**
 * Read an owner-selected site's latest current GitHub source DIRECTLY against
 * a server-held, current verified reference. `siteId` is just a selector.
 * The backend MUST authenticate/bind `reference` to this session itself (e.g.
 * short-lived signed/sealed server ticket), never trust a browser JSON object.
 * Recheck user, exact repo/project and branch before/after SHA-pinned source GET.
 *
 * Source HTML is internal and untrusted. Optional publication checks compare
 * the canonical public homepage with exact GitHub bytes. That comparison
 * establishes current byte equality and has no historic approval authority.
 */
export async function readCurrentManagedHomepage({
  siteId, reference, includePublication = false, ...options
} = {}) {
  const read = await ownedReferenceReader(siteId, reference, options);
  const {owner, get, authorized} = read;
  const verified = await verifyCurrentSite(read, reference);
  const current = await get('github', verified.root +
    '/contents/public/index.html?ref=' + verified.baseCommitSha, {allow404: true});
  if (!current) denied('current_source_requires_review');
  const {bytes, html} = decodeGitHubFile(current);
  const contentSha256 = await sha256Bytes(bytes); // Exact Git blob bytes, INCLUDING BOM.
  await authorized();

  const website = 'https://' + verified.project.name + '.pages.dev/';
  const production = includePublication === true ? productionSnapshot(verified.project) : null;
  const checked = production?.commit === verified.baseCommitSha
    ? {id: production.id, state: await checkPublicHomepage(read, options.fetchFn ?? fetch, website, bytes)}
    : null;

  // A same-name repository/project swap or moving main is never authorized by
  // an old SHA. Repeat exact provider reads without scanning every account site.
  const branch = await get('github', verified.root + '/branches/main');
  const repository = await get('github', verified.root);
  const projectResult = await get('cloudflare', verified.projectPath);
  if (branch?.commit?.sha?.toLowerCase() !== verified.baseCommitSha ||
      repository?.id !== reference.repositoryId ||
      projectResult?.result?.id !== reference.pagesProjectId ||
      !exactManagedProject(projectResult.result, repository, owner))
    denied('current_source_changed');
  await authorized();
  return {
    status: 'github_current_source_verified',
    siteId: reference.siteId, baseCommitSha: verified.baseCommitSha,
    homepageHtmlSha256: contentSha256, homepageGitBlobSha: current.sha.toLowerCase(),
    publicationVerified: false, historicalContinuityVerified: false,
    editMode: 'approved_migration_required',
    ...(includePublication === true ? {publicationCheck: publicationProjection(projectResult.result,
      verified.baseCommitSha, checked, website, contentSha256, Math.floor(Date.now() / 1000))} : {}),
    html // INTERNAL untrusted bytes represented as UTF-8, preserving BOM.
  };
}
