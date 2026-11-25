// GPT-6 / #86. Read-only metadata inspection of an existing, owner-approved
// Pages preview. Never return or fetch a preview URL or assert Access protection.
// Provider-backed protection plus signed-in canonical '/' verification is a
// separate release gate (#86/#96).
import { matchesApprovedPagesProject } from './approved-pages-project.mjs';
import { isManagedRepositoryDescription } from './managed-site-repository.mjs';
import { classifyPreviewPolicy } from './pages-preview-policy.mjs';
// This module NEVER enables previews, publishes content, creates PRs, or trusts a URL
// supplied by the browser. Call it only with server-verified site inventory and a
// server-persisted, separately confirmed per-PR approval receipt.
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const UPDATE_BRANCH = /^launch-and-own\/site-[a-f0-9]{20}$/;
const DEPLOYMENT_ID = /^[a-zA-Z0-9-]{8,64}$/;
const enc = encodeURIComponent;
function sameGitHubId(value, expected) {
  // Mirror the strict positive, safe primitive-ID rule in #95 until it merges.
  const valid = v => (typeof v === 'number' || (typeof v === 'string' && /^[1-9]\d*$/.test(v))) &&
    Number.isSafeInteger(Number(v)) && Number(v) > 0;
  return valid(value) && valid(expected) && String(Number(value)) === String(Number(expected));
}

function denied(code) { return { status: code, previewUrl: null, productionVerified: false }; }
function required(input) {
  const s = input?.site;
  const c = input?.consent;
  if (!s || typeof s !== 'object' ||
      !Number.isSafeInteger(s.githubUserId) || s.githubUserId <= 0 ||
      !Number.isSafeInteger(s.githubRepositoryId) || s.githubRepositoryId <= 0 ||
      typeof s.githubOwner !== 'string' || !/^[\w-]{1,39}$/.test(s.githubOwner) ||
      typeof s.githubRepositoryName !== 'string' || !/^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.githubRepositoryName) ||
      !ACCOUNT.test(s.cloudflareAccountId || '') ||
      typeof s.pagesProjectId !== 'string' || !s.pagesProjectId ||
      s.pagesProjectName !== s.githubRepositoryName + '-site' ||
      s.productionBranch !== 'main' ||
      !Number.isSafeInteger(input?.prNumber) || input.prNumber < 1 ||
      !DEPLOYMENT_ID.test(input?.deploymentId || '')) return false;
  if (!c || c.explicitlyApproved !== true || c.publicExposureAcknowledged !== true ||
      c.privatePreviewRequired === true ||
      c.githubUserId !== s.githubUserId || c.githubRepositoryId !== s.githubRepositoryId ||
      c.cloudflareAccountId !== s.cloudflareAccountId || c.pagesProjectId !== s.pagesProjectId ||
      c.prNumber !== input.prNumber || !SHA.test(c.approvedHeadSha || '') ||
      !SHA.test(c.approvedBaseSha || '') ||
      !DIGEST.test(c.approvedHtmlSha256 || '') ||
      !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= Math.floor(Date.now() / 1000)) return false;
  return true;
}
function validateProject(project, site) {
  const cfg = project?.source?.config;
  // Reuse the shared #95-approved project matcher. These explicit ID fences
  // apply even before #95's stronger implementation is merged into main.
  return matchesApprovedPagesProject(project, {
    name: site.pagesProjectName, owner: site.githubOwner, ownerId: site.githubUserId,
    repositoryName: site.githubRepositoryName, repositoryId: site.githubRepositoryId,
    branch: 'main', projectId: site.pagesProjectId
  }) && sameGitHubId(cfg?.repo_id, site.githubRepositoryId) &&
    (cfg?.owner_id == null || sameGitHubId(cfg.owner_id, site.githubUserId));
}
function safeImmutableUrl(raw, projectName, deploymentShortId) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    const suffix = '.' + projectName + '.pages.dev';
    const label = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : '';
    // Never issue public HTML checks to an untrusted arbitrary URL, a production
    // hostname, a branch alias with nested subdomains, or a custom domain.
    if (!/^[a-f0-9]{8}$/.test(deploymentShortId || '') || label !== deploymentShortId ||
        url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash ||
        !/^[a-z0-9-]{8,64}$/.test(label)) return null;
    return url.origin;
  } catch { return null; }
}
async function getJson(fetchFn, url, token, {cloudflare = false} = {}) {
  const response = await fetchFn(url, {method: 'GET', redirect: 'manual', headers: {
    authorization: `Bearer ${token}`,
    accept: cloudflare ? 'application/json' : 'application/vnd.github+json',
    ...(cloudflare ? {} : {'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own'})
  }});
  if (response.status === 401 || response.status === 403) throw Error('Preview provider authorization is unavailable; reconnect and review again');
  if (!response.ok) throw Error(`Preview provider read failed (HTTP ${response.status})`);
  const payload = await response.json();
  if (cloudflare && (payload?.success !== true || !payload.result))
    throw Error('Cloudflare preview read was not verified');
  return cloudflare ? payload.result : payload;
}
/**
 * Provider records are re-fetched using active owner-scoped grants; no resource
 * writes are performed. assertCurrentAuthorization(snapshot) is required and
 * must independently recheck the live session epoch, grants and account/site
 * selection at every boundary. A static true callback is NOT sufficient in production. `site` and `consent` MUST come from trusted backend state,
 * NEVER request fields or a model response. Never returns a preview URL or claims content/Access protection.
 * This is not a preview-enablement action or a canonical production verifier.
 */
export async function verifyExistingPrPreview(input, {
  githubToken, cloudflareToken, assertCurrentAuthorization, fetchFn = fetch
} = {}) {
  if (!required(input)) return denied('blocked-approval-or-inventory');
  if (typeof assertCurrentAuthorization !== 'function')
    return denied('blocked-authorization-fence');
  if (typeof githubToken !== 'string' || !githubToken ||
      typeof cloudflareToken !== 'string' || !cloudflareToken) return denied('reauthorization-required');
  // Everything here is an immutable, server-trusted snapshot, NOT browser fields.
  const s = Object.freeze({...input.site});
  const c = Object.freeze({...input.consent});
  const {prNumber, deploymentId} = input;
  const snapshot = Object.freeze({
    githubUserId: s.githubUserId, githubRepositoryId: s.githubRepositoryId,
    githubOwner: s.githubOwner, githubRepositoryName: s.githubRepositoryName,
    cloudflareAccountId: s.cloudflareAccountId, pagesProjectId: s.pagesProjectId,
    pagesProjectName: s.pagesProjectName, productionBranch: s.productionBranch,
    prNumber, deploymentId, approvedBaseSha: c.approvedBaseSha,
    approvedHeadSha: c.approvedHeadSha, approvedHtmlSha256: c.approvedHtmlSha256,
    expiresAt: c.expiresAt
  });
  async function authorized() {
    if (!required(input) ||
        Object.keys(s).some(key => input.site?.[key] !== s[key]) ||
        Object.keys(c).some(key => input.consent?.[key] !== c[key]) ||
        input.prNumber !== prNumber || input.deploymentId !== deploymentId)
      return false;
    try {
      // The caller MUST check a live auth epoch/provider grants/account selection.
      // It gets no tokens or provider preview URLs.
      const allowed = await assertCurrentAuthorization(snapshot);
      return allowed === true && required(input) &&
        Object.keys(s).every(key => input.site?.[key] === s[key]) &&
        Object.keys(c).every(key => input.consent?.[key] === c[key]) &&
        input.prNumber === prNumber && input.deploymentId === deploymentId;
    } catch { return false; }
  }
  if (!await authorized()) return denied('authorization-changed-or-expired');
  const ghRoot = `https://api.github.com/repos/${enc(s.githubOwner)}/${enc(s.githubRepositoryName)}`;
  const cfRoot = `https://api.cloudflare.com/client/v4/accounts/${s.cloudflareAccountId}/pages/projects/${enc(s.pagesProjectName)}`;
  const [user, repo, pr, project] = await Promise.all([
    getJson(fetchFn, 'https://api.github.com/user', githubToken),
    getJson(fetchFn, ghRoot, githubToken),
    getJson(fetchFn, ghRoot + '/pulls/' + prNumber, githubToken),
    getJson(fetchFn, cfRoot, cloudflareToken, {cloudflare: true})
  ]);
  if (!await authorized()) return denied('authorization-changed-or-expired');
  const slug = s.githubRepositoryName.slice(4);
  if (user?.id !== s.githubUserId || user?.login?.toLowerCase() !== s.githubOwner.toLowerCase() ||
      repo?.id !== s.githubRepositoryId || repo?.owner?.id !== s.githubUserId ||
      repo?.owner?.login?.toLowerCase() !== s.githubOwner.toLowerCase() ||
      repo?.name !== s.githubRepositoryName || repo?.private !== true ||
      repo?.default_branch !== 'main' || !isManagedRepositoryDescription(repo?.description, slug))
    return denied('blocked-github-ownership');
  if (!validateProject(project, s)) return denied('blocked-pages-project-identity');
  const {state: policy} = classifyPreviewPolicy(project);
  if (policy === 'off') return denied('preview-disabled');
  if (policy !== 'scoped') return denied('blocked-unsafe-preview-policy');
  const branch = pr?.head?.ref;
  if (pr?.state !== 'open' || pr?.number !== prNumber ||
      pr?.base?.ref !== 'main' || pr?.base?.sha !== c.approvedBaseSha ||
      pr?.base?.repo?.id !== s.githubRepositoryId ||
      (pr?.base?.repo?.owner?.id != null && pr.base.repo.owner.id !== s.githubUserId) ||
      pr?.head?.repo?.id !== s.githubRepositoryId ||
      (pr?.head?.repo?.owner?.id != null && pr.head.repo.owner.id !== s.githubUserId) ||
      !UPDATE_BRANCH.test(branch || '') || pr?.head?.sha !== c.approvedHeadSha)
    return denied('blocked-pr-or-revision');
  const [baseBranch, ghBranch] = await Promise.all([
    getJson(fetchFn, ghRoot + '/branches/main', githubToken),
    getJson(fetchFn, ghRoot + '/branches/' + enc(branch), githubToken)
  ]);
  if (!await authorized()) return denied('authorization-changed-or-expired');
  if (baseBranch?.commit?.sha !== c.approvedBaseSha)
    return denied('blocked-pr-base-moved');
  if (ghBranch?.commit?.sha !== c.approvedHeadSha)
    return denied('blocked-pr-head-moved');
  const deployment = await getJson(fetchFn, cfRoot + '/deployments/' + enc(deploymentId), cloudflareToken, {cloudflare: true});
  if (!await authorized()) return denied('authorization-changed-or-expired');
  if (deployment?.id !== deploymentId || deployment?.project_id !== s.pagesProjectId ||
      deployment?.project_name !== s.pagesProjectName ||
      deployment?.environment !== 'preview' || deployment?.is_skipped === true ||
      deployment?.latest_stage?.name !== 'deploy' || deployment?.latest_stage?.status !== 'success' ||
      deployment?.deployment_trigger?.type !== 'github:push' ||
      deployment?.deployment_trigger?.metadata?.branch !== branch ||
      deployment?.deployment_trigger?.metadata?.commit_hash !== c.approvedHeadSha ||
      deployment?.deployment_trigger?.metadata?.commit_dirty === true)
    return denied('preview-not-verified');
  if (!safeImmutableUrl(deployment.url, s.pagesProjectName, deployment.short_id))
    return denied('blocked-preview-url');
  if (!await authorized()) return denied('authorization-changed-or-expired');
  // Never access /index.html anonymously. Authenticated canonical '/' review and
  // independently observed Access policy/host protection are not in current scopes.
  return {
    status: 'preview-metadata-verified-protection-pending',
    previewUrl: null, deploymentId, githubBaseSha: c.approvedBaseSha,
    githubHeadSha: c.approvedHeadSha, environment: 'preview',
    protectionVerified: false, contentVerified: false, productionVerified: false,
    note: 'Deployment metadata only; access protection and signed-in canonical content have not been verified.'
  };
}
