// Issue #39 / GPT-6: derive current managed-site inventory from owner-scoped
// provider reads, not expiring launch-history records or browser-provided IDs.
// This adapter makes NO GitHub/Cloudflare writes and stores NO customer data.
import { matchesApprovedPagesProject } from './approved-pages-project.mjs';
import { isManagedRepositoryDescription } from './managed-site-repository.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const PROJECT = /^(esp-[a-z0-9]+(?:-[a-z0-9]+)*)-site$/;
const OPAQUE = /^[a-z0-9_-]{1,128}$/i;
const GIT_SHA = /^[a-f0-9]{40}$/i;
const NUMERIC = /^[1-9][0-9]*$/;
const MAX_PAGES = 10;
const PER_PAGE = 10;
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
  if (!id(principal?.githubUserId) || typeof principal.githubUserId !== 'number' ||
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

  async function authorized() {
    if (principal?.githubUserId !== owner.githubUserId ||
        principal?.githubLogin !== owner.githubLogin ||
        principal?.cloudflareAccountId !== owner.cloudflareAccountId) denied('authorization_changed');
    try {
      if (await assertCurrentAuthorization(owner) !== true) denied('authorization_changed');
    } catch {
      denied('authorization_changed');
    }
    if (principal?.githubUserId !== owner.githubUserId ||
        principal?.githubLogin !== owner.githubLogin ||
        principal?.cloudflareAccountId !== owner.cloudflareAccountId) denied('authorization_changed');
  }
  async function get(provider, path, {allow404 = false} = {}) {
    await authorized();
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
    if (response?.status === 403) denied(provider + '_permission_denied');
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
    return provider === 'github' ? data : data;
  }
  return {owner, get, authorized};
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
function safeSite(owner, repository, project, baseCommitSha) {
  const siteId = 'managed_' + repository.id + '_' + project.id;
  // Match the merged #84 capability projection's maximum 128-character site ID.
  if (siteId.length > 128) denied('invalid_managed_identity');
  return Object.freeze({
    siteId, githubUserId: owner.githubUserId, githubOwner: owner.githubLogin,
    cloudflareAccountId: owner.cloudflareAccountId,
    repositoryId: repository.id, repositoryName: repository.name,
    pagesProjectId: project.id, pagesProjectName: project.name,
    branch: 'main', productionBranch: 'main', sourceKind: 'managed-existing',
    baseCommitSha, productionCommitSha: publicCommit(project),
    publicationVerified: false,
    sourceState: 'github_main_verified_publication_unverified',
    repositoryUrl: 'https://github.com/' + owner.githubLogin + '/' + repository.name,
    pagesProjectDashboardUrl: 'https://dash.cloudflare.com/' + owner.cloudflareAccountId +
      '/pages/view/' + project.name
  });
}

async function listWithReader(read) {
  const {owner, get, authorized} = read;
  const user = await get('github', '/user');
  if (user?.id !== owner.githubUserId ||
      user?.login?.toLowerCase() !== owner.githubLogin.toLowerCase())
    denied('github_owner_mismatch');

  const root = '/accounts/' + owner.cloudflareAccountId + '/pages/projects';
  const results = [], seen = new Set();
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const data = await get('cloudflare', root + '?page=' + page + '&per_page=' + PER_PAGE);
    if (!Array.isArray(data.result)) denied('cloudflare_unexpected_response');
    const list = data.result;
    const info = data.result_info;
    if (info) {
      if (!Number.isSafeInteger(info.total_pages) || info.total_pages < 1 ||
          !Number.isSafeInteger(info.page) || info.page !== page ||
          info.total_pages > MAX_PAGES || (page > 1 && info.total_pages !== pages))
        denied('cloudflare_pagination_unverified');
      pages = info.total_pages;
    } else if (list.length >= PER_PAGE) {
      // Never report an incomplete account inventory as complete.
      denied('cloudflare_pagination_unverified');
    }
    if (list.length > PER_PAGE) denied('cloudflare_pagination_unverified');

    for (const entry of list) {
      if (!PROJECT.test(entry?.name ?? '')) continue;
      if (!OPAQUE.test(entry?.id ?? '') || seen.has(entry.name))
        denied('cloudflare_pagination_unverified');
      seen.add(entry.name);
      const projectResult = await get('cloudflare', root + '/' + encodeURIComponent(entry.name), {allow404: true});
      if (!projectResult?.result) continue; // Removed between list and read.
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
  }
  await authorized();
  return Object.freeze({status: 'fresh_owner_scoped_inventory', accountId: owner.cloudflareAccountId,
    scanCompleted: true, sites: Object.freeze(results)});
}

/**
 * Backend-only, zero-storage discovery after launch receipts expire.
 * The principal comes from the current authorized backend session. The callback
 * MUST independently verify that session hash, authorization epoch, selected
 * account and live grants on each call; an in-memory boolean is insufficient.
 * Provider pagination is bounded and incomplete scans fail, not silently omit.
 */
export async function discoverOwnedManagedSites(options = {}) {
  return listWithReader(reader(options));
}

async function sha256(content) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
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
  let bytes;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, x => x.charCodeAt(0));
  } catch { denied('current_source_requires_review'); }
  if (bytes.length !== file.size) denied('current_source_requires_review');
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { denied('current_source_requires_review'); }
}

/**
 * Read the *current* GitHub main HTML, not an expired launch snapshot. siteId is
 * only a selector: rediscover and verify ownership again before using it.
 * The returned HTML is INTERNAL/UNTRUSTED customer content: never inject into
 * the onboarding origin or use as automatic editable structured config.
 * Older one-page repos lack an approved sidecar; any migration requires a
 * separate, exact-HTML-reviewed feature PR, not a silent main rewrite.
 */
export async function readCurrentManagedHomepage({siteId, ...options} = {}) {
  if (typeof siteId !== 'string' || !/^managed_[1-9][0-9]*_[a-z0-9_-]{1,128}$/i.test(siteId))
    denied('invalid_site_selector');
  const read = reader(options);
  const inventory = await listWithReader(read);
  const site = inventory.sites.find(item => item.siteId === siteId);
  if (!site) denied('owned_site_not_found');
  const root = '/repos/' + encodeURIComponent(site.githubOwner) + '/' + site.repositoryName;
  const current = await read.get('github', root + '/contents/public/index.html?ref=' + site.baseCommitSha,
    {allow404: true});
  if (!current) denied('current_source_requires_review');
  const html = decodeGitHubFile(current);
  const contentSha256 = await sha256(html);
  await read.authorized();

  // Ensure no new main commit or switched repo/project occurred during this
  // source read. A valid old SHA is NOT authority to propose an update today.
  const branch = await read.get('github', root + '/branches/main');
  const repo = await read.get('github', root);
  const pages = await read.get('cloudflare', '/accounts/' + site.cloudflareAccountId +
    '/pages/projects/' + site.pagesProjectName);
  if (branch?.commit?.sha?.toLowerCase() !== site.baseCommitSha ||
      repo?.id !== site.repositoryId || !pages?.result ||
      pages.result.id !== site.pagesProjectId || !exactManagedProject(pages.result, repo, read.owner))
    denied('current_source_changed');
  await read.authorized();
  return {
    status: 'github_current_source_verified', siteId: site.siteId,
    baseCommitSha: site.baseCommitSha, homepageHtmlSha256: contentSha256,
    homepageGitBlobSha: current.sha.toLowerCase(),
    publicationVerified: false, editMode: 'approved_migration_required',
    html // INTERNAL: untrusted customer content, never render unsandboxed.
  };
}
