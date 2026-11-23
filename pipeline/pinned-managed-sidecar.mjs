// #39 / GPT-6: one owner-scoped, read-only GitHub sidecar evidence read.
// No writes, no UI route, no trust in client-submitted source references.
import {readCurrentManagedHomepage, ManagedSiteInventoryError}
  from './owned-site-inventory.mjs';
import {matchesApprovedPagesProject} from './approved-pages-project.mjs';
import {isManagedRepositoryDescription} from './managed-site-repository.mjs';

export const PINNED_MANAGED_SIDECAR_PATH = '.launch-and-own/site-config.json';
const GIT_SHA = /^[a-f0-9]{40}$/i;
const MAX_SIDECAR_BYTES = 16 * 1024;
const SIDECAR_URL_PATH = '/contents/.launch-and-own/site-config.json';

export class PinnedSidecarError extends Error {
  constructor(code) {
    super('Pinned managed-site configuration evidence unavailable (' + code + ')');
    this.name = 'PinnedSidecarError';
    this.code = code;
  }
}
const deny = code => { throw new PinnedSidecarError(code); };
const encode = encodeURIComponent;
function copyInputs(options) {
  let principal, reference;
  try {
    principal = structuredClone(options?.principal);
    reference = structuredClone(options?.reference);
  } catch { deny('verified_reference_required'); }
  if (!principal || !reference || typeof options?.assertCurrentAuthorization !== 'function' ||
      typeof options.githubAccessToken !== 'string' || !options.githubAccessToken ||
      typeof options.cloudflareAccessToken !== 'string' || !options.cloudflareAccessToken)
    deny('verified_reference_required');
  // #98 revalidates every immutable owner, repo and linked Pages resource.
  // Keep this copy separate from caller-mutated objects during all awaits.
  const originals = [options.principal, options.reference], copies = [principal, reference];
  let initial;
  try { initial = originals.map(x => JSON.stringify(x)); }
  catch { deny('verified_reference_required'); }
  function unchanged() {
    try {
      if (originals.some((x, i) => JSON.stringify(x) !== initial[i]))
        deny('verified_reference_changed');
    } catch { deny('verified_reference_changed'); }
  }
  return {principal, reference, unchanged};
}
async function digest(bytes) {
  const raw = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(raw), x => x.toString(16).padStart(2, '0')).join('');
}
function decodedGitHubBlob(file) {
  if (file?.type !== 'file' || file.encoding !== 'base64' ||
      typeof file.content !== 'string' || typeof file.sha !== 'string' ||
      !GIT_SHA.test(file.sha) || !Number.isSafeInteger(file.size) ||
      file.size < 0 || file.size > MAX_SIDECAR_BYTES)
    deny('sidecar_content_unverifiable');
  const encoded = file.content.replace(/\s/g, '');
  if (encoded.length > Math.ceil(MAX_SIDECAR_BYTES / 3) * 4 + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    deny('sidecar_content_unverifiable');
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, x => x.charCodeAt(0));
    if (bytes.length !== file.size) deny('sidecar_content_unverifiable');
    const raw = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    return {raw, bytes, blobSha: file.sha.toLowerCase()};
  } catch { deny('sidecar_content_unverifiable'); }
}
function matchesReference(repo, project, current, reference, principal) {
  const name = reference.repositoryName;
  const projectName = name + '-site';
  const source = project?.source?.config;
  return repo?.id === reference.repositoryId &&
    repo.name === name && repo.private === true && repo.default_branch === 'main' &&
    repo.owner?.id === principal.githubUserId &&
    repo.owner?.login?.toLowerCase() === principal.githubLogin.toLowerCase() &&
    isManagedRepositoryDescription(repo.description, name.slice(4)) &&
    project?.id === reference.pagesProjectId &&
    source?.repo_name === name &&
    matchesApprovedPagesProject(project, {
      name: projectName, projectId: reference.pagesProjectId,
      owner: principal.githubLogin, ownerId: principal.githubUserId,
      repositoryName: name, repositoryId: reference.repositoryId, branch: 'main'
    }) &&
    current.siteId === reference.siteId &&
    current.baseCommitSha === reference.baseCommitSha;
}

/**
 * INTERNAL backend-only sidecar proof to accompany one #98 SHA-pinned source.
 *
 * REQUIRES: authenticated server-held/sealed #98 reference, fresh current owner
 * principal, refreshed GitHub/Cloudflare tokens, live D1 authorization-epoch
 * checker. The caller (not this adapter) must authenticate the reference ticket.
 *
 * Combines #98's eight GETs with a pinned sidecar GET and three final provider
 * GETs = at most 12 external reads, plus bounded live authorization checks.
 * An honest 404 after verified private-repo access records absence at that SHA.
 * A 200 returns the SHA-256 of the EXACT fetched sidecar bytes, plus its GitHub
 * blob ID. Never auto-creates the file or claims generated-one-page eligibility.
 *
 * The returned source HTML and sidecarRaw are PRIVATE, UNTRUSTED backend bytes;
 * never render them in onboarding origin or return to an unapproved browser.
 */
export async function readPinnedManagedSidecar(options = {}) {
  const frozen = copyInputs(options);
  const {principal, reference, unchanged} = frozen;
  const authSnapshot = Object.freeze({
    githubUserId: principal.githubUserId, githubLogin: principal.githubLogin,
    cloudflareAccountId: principal.cloudflareAccountId
  });
  async function authorized() {
    unchanged();
    let ok;
    try { ok = await options.assertCurrentAuthorization(authSnapshot); }
    catch { deny('authorization_changed'); }
    unchanged();
    if (ok !== true) deny('authorization_changed');
  }
  const fetchFn = options.fetchFn ?? fetch;
  const shared = {siteId: options.siteId, reference, principal,
    githubAccessToken: options.githubAccessToken,
    cloudflareAccessToken: options.cloudflareAccessToken,
    assertCurrentAuthorization: options.assertCurrentAuthorization, fetchFn};
  let currentSource;
  try { currentSource = await readCurrentManagedHomepage(shared); }
  catch (err) {
    if (err instanceof ManagedSiteInventoryError)
      deny(err.code === 'authorization_changed' ? 'authorization_changed' :
        'current_source_unavailable');
    deny('current_source_unavailable');
  }
  unchanged();
  if (currentSource?.siteId !== reference.siteId ||
      currentSource.baseCommitSha !== reference.baseCommitSha ||
      !GIT_SHA.test(currentSource.baseCommitSha))
    deny('current_source_changed');

  const root = '/repos/' + encode(principal.githubLogin) +
    '/' + encode(reference.repositoryName);
  const accountPath = '/accounts/' + encode(principal.cloudflareAccountId) +
    '/pages/projects/' + encode(reference.pagesProjectName);

  async function get(provider, path, {allow404 = false} = {}) {
    await authorized();
    let response;
    const isGitHub = provider === 'github';
    try {
      response = await fetchFn((isGitHub ? 'https://api.github.com' :
        'https://api.cloudflare.com/client/v4') + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: isGitHub ? {
          authorization: 'Bearer ' + options.githubAccessToken,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own'
        } : {authorization: 'Bearer ' + options.cloudflareAccessToken,
          accept: 'application/json'}
      });
    } catch { deny(provider + '_temporarily_unavailable'); }
    await authorized();
    if (response?.status === 401) deny(provider + '_reauthorization_required');
    if (response?.status === 403) {
      if (response.headers?.get('retry-after') ||
          response.headers?.get('x-ratelimit-remaining') === '0')
        deny(provider + '_rate_limited');
      deny(provider + '_permission_denied');
    }
    if (response?.status === 429) deny(provider + '_rate_limited');
    if (response?.status === 404 && allow404) return null;
    if (!response?.ok || response.status >= 300)
      deny(provider + '_temporarily_unavailable');
    let data;
    try { data = await response.json(); }
    catch { deny(provider + '_unexpected_response'); }
    await authorized();
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (!isGitHub && data.success !== true))
      deny(provider + '_unexpected_response');
    return isGitHub ? data : data.result;
  }

  const path = root + SIDECAR_URL_PATH + '?ref=' + currentSource.baseCommitSha;
  const sidecar = await get('github', path, {allow404: true});
  let sidecarRaw = null, sidecarEvidence;
  const base = {path: PINNED_MANAGED_SIDECAR_PATH,
    siteId: currentSource.siteId, refCommitSha: currentSource.baseCommitSha};
  if (sidecar === null) {
    sidecarEvidence = {...base, exists: false};
  } else {
    const {raw, bytes, blobSha} = decodedGitHubBlob(sidecar);
    const contentSha256 = await digest(bytes);
    await authorized();
    sidecarRaw = raw;
    sidecarEvidence = {...base, exists: true, blobSha, contentSha256};
  }

  // A PINNED old Git SHA is not proof the branch/project still owns it now.
  // Disallow a same-name resource replacement or moving main during the GET.
  const branch = await get('github', root + '/branches/main');
  const repo = await get('github', root);
  const project = await get('cloudflare', accountPath);
  if (branch?.commit?.sha?.toLowerCase() !== currentSource.baseCommitSha ||
      !matchesReference(repo, project, currentSource, reference, principal))
    deny('current_source_changed');
  await authorized();
  return {
    status: 'pinned_sidecar_evidence_verified', currentSource,
    sidecarEvidence, sidecarRaw,
    // No historic or provenance claim. #103 requires an additional independent
    // generated-one-page eligibility callback before it produces review plans.
    historicalContinuityVerified: false, editorEligible: false,
    providerWriteAuthorized: false
  };
}
