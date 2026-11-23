// Read-only verification of an already-existing, consented Cloudflare Pages PR preview.
// This module NEVER enables previews, publishes content, creates PRs, or trusts a URL
// supplied by the browser. Call it only with server-verified site inventory and a
// server-persisted, separately confirmed per-PR approval receipt.
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const UPDATE_BRANCH = /^launch-and-own\/site-[a-f0-9]{20}$/;
const DEPLOYMENT_ID = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const enc = encodeURIComponent;
const approvedInclude = 'launch-and-own/site-*';

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
      !DIGEST.test(c.approvedHtmlSha256 || '') ||
      !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= Math.floor(Date.now() / 1000)) return false;
  return true;
}
function managedDescription(desc, slug) {
  if (desc === `Launch & Own managed site: ${slug}` || desc === `Elite Site Pipeline managed site: ${slug}`) return true;
  return typeof desc === 'string' &&
    new RegExp(`^Launch & Own managed site: ${slug} \\[job:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\\]$`).test(desc);
}
function validateProject(project, site) {
  const cfg = project?.source?.config;
  return project?.id === site.pagesProjectId && project?.name === site.pagesProjectName &&
    project?.subdomain === site.pagesProjectName + '.pages.dev' &&
    project?.production_branch === 'main' && project?.source?.type === 'github' &&
    cfg?.owner?.toLowerCase() === site.githubOwner.toLowerCase() &&
    String(cfg?.repo_id) === String(site.githubRepositoryId) &&
    cfg?.repo_name === site.githubRepositoryName && cfg?.production_deployments_enabled !== false &&
    project?.uses_functions !== true &&
    !project?.build_config?.build_command &&
    ['', '/', null, undefined].includes(project?.build_config?.root_dir) &&
    ['public', '/public'].includes(project?.build_config?.destination_dir);
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
async function htmlSha256(fetchFn, url) {
  const response = await fetchFn(url + '/index.html', {method: 'GET', redirect: 'manual', headers: {accept: 'text/html'}});
  if (response.status !== 200 || !response.headers?.get('content-type')?.toLowerCase().startsWith('text/html'))
    return null;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_HTML_BYTES) return null;
  if (!response.body || typeof response.body.getReader !== 'function') return null;
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) return null;
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Provider records are re-fetched using active owner-scoped grants; no resource
 * writes are performed. `site` and `consent` MUST come from trusted backend state,
 * NEVER request fields or a model response. Returns no URL until every check passes.
 * This is not a preview-enablement action or a canonical production verifier.
 */
export async function verifyExistingPrPreview(input, {githubToken, cloudflareToken, fetchFn = fetch} = {}) {
  if (!required(input)) return denied('blocked-approval-or-inventory');
  if (typeof githubToken !== 'string' || !githubToken ||
      typeof cloudflareToken !== 'string' || !cloudflareToken) return denied('reauthorization-required');
  const {site: s, consent: c, prNumber, deploymentId} = input;
  const ghRoot = `https://api.github.com/repos/${enc(s.githubOwner)}/${enc(s.githubRepositoryName)}`;
  const cfRoot = `https://api.cloudflare.com/client/v4/accounts/${s.cloudflareAccountId}/pages/projects/${enc(s.pagesProjectName)}`;
  const [user, repo, pr, project] = await Promise.all([
    getJson(fetchFn, 'https://api.github.com/user', githubToken),
    getJson(fetchFn, ghRoot, githubToken),
    getJson(fetchFn, ghRoot + '/pulls/' + prNumber, githubToken),
    getJson(fetchFn, cfRoot, cloudflareToken, {cloudflare: true})
  ]);
  const slug = s.githubRepositoryName.slice(4);
  if (user?.id !== s.githubUserId || user?.login?.toLowerCase() !== s.githubOwner.toLowerCase() ||
      repo?.id !== s.githubRepositoryId || repo?.owner?.id !== s.githubUserId ||
      repo?.owner?.login?.toLowerCase() !== s.githubOwner.toLowerCase() ||
      repo?.name !== s.githubRepositoryName || repo?.private !== true ||
      repo?.default_branch !== 'main' || !managedDescription(repo?.description, slug))
    return denied('blocked-github-ownership');
  if (!validateProject(project, s)) return denied('blocked-pages-project-identity');
  const cfg = project.source.config;
  if (cfg.preview_deployment_setting === 'none') return denied('preview-disabled');
  if (cfg.preview_deployment_setting !== 'custom' ||
      !Array.isArray(cfg.preview_branch_includes) ||
      cfg.preview_branch_includes.length !== 1 || cfg.preview_branch_includes[0] !== approvedInclude ||
      (cfg.preview_branch_excludes != null &&
        (!Array.isArray(cfg.preview_branch_excludes) || cfg.preview_branch_excludes.length !== 0)) ||
      cfg.pr_comments_enabled === true)
    return denied('blocked-unsafe-preview-policy');
  const branch = pr?.head?.ref;
  if (pr?.state !== 'open' || pr?.number !== prNumber ||
      pr?.base?.ref !== 'main' || pr?.base?.repo?.id !== s.githubRepositoryId ||
      pr?.head?.repo?.id !== s.githubRepositoryId ||
      !UPDATE_BRANCH.test(branch || '') || pr?.head?.sha !== c.approvedHeadSha)
    return denied('blocked-pr-or-revision');
  const ghBranch = await getJson(fetchFn, ghRoot + '/branches/' + enc(branch), githubToken);
  if (ghBranch?.commit?.sha !== c.approvedHeadSha)
    return denied('blocked-pr-head-moved');
  const deployment = await getJson(fetchFn, cfRoot + '/deployments/' + enc(deploymentId), cloudflareToken, {cloudflare: true});
  if (deployment?.id !== deploymentId || deployment?.project_id !== s.pagesProjectId ||
      deployment?.project_name !== s.pagesProjectName ||
      deployment?.environment !== 'preview' || deployment?.is_skipped === true ||
      deployment?.latest_stage?.name !== 'deploy' || deployment?.latest_stage?.status !== 'success' ||
      deployment?.deployment_trigger?.type !== 'github:push' ||
      deployment?.deployment_trigger?.metadata?.branch !== branch ||
      deployment?.deployment_trigger?.metadata?.commit_hash !== c.approvedHeadSha ||
      deployment?.deployment_trigger?.metadata?.commit_dirty === true)
    return denied('preview-not-verified');
  const url = safeImmutableUrl(deployment.url, s.pagesProjectName, deployment.short_id);
  if (!url) return denied('blocked-preview-url');
  const observedHtmlSha256 = await htmlSha256(fetchFn, url);
  if (observedHtmlSha256 !== c.approvedHtmlSha256)
    return denied('blocked-preview-html-mismatch');
  return {status: 'preview-verified', previewUrl: url,
    deploymentId, githubHeadSha: c.approvedHeadSha,
    htmlSha256: observedHtmlSha256, environment: 'preview', productionVerified: false,
    note: 'Public preview only; the PR has not been merged and production is not verified.'};
}
