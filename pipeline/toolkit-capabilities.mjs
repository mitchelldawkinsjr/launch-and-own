import { matchesApprovedPagesProject } from './approved-pages-project.mjs';
import { isManagedRepositoryDescription } from './managed-site-repository.mjs';

export const TOOLKIT_CAPABILITY_STATES = Object.freeze([
  'included_verified', 'available_opt_in', 'active_verified', 'manual_setup', 'blocked_permission_or_plan', 'not_available'
]);

const accountId = /^[a-f0-9]{32}$/i;
const gitSha = /^[a-f0-9]{40}$/i;
const sha256 = /^[a-f0-9]{64}$/i;
const login = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const repositoryName = /^esp-[a-z\d]+(?:-[a-z\d]+)*$/;
const opaqueId = /^[a-z\d_-]{1,128}$/i;
const branchName = /^[a-z\d._/-]+$/i;
const sources = new Set(['generated', 'uploaded-zip', 'managed-existing']);
const validGitHubId = value => Number.isSafeInteger(value) && value > 0;
const fits = (pattern, value) => typeof value === 'string' && pattern.test(value);

function matchesOwnedSite(viewer, reference, repository, pagesAccountId, project) {
  if (!validGitHubId(viewer?.githubUserId) || !fits(login, viewer.githubLogin)
      || !fits(accountId, viewer.cloudflareAccountId) || pagesAccountId !== viewer.cloudflareAccountId
      || reference?.githubUserId !== viewer.githubUserId
      || reference.cloudflareAccountId !== viewer.cloudflareAccountId || !fits(opaqueId, reference.siteId)
      || !fits(opaqueId, reference.pagesProjectId) || !validGitHubId(reference.repositoryId)
      || !fits(repositoryName, reference.repositoryName) || !fits(branchName, reference.productionBranch)
      || !sources.has(reference.sourceKind)) return false;

  const owner = viewer.githubLogin;
  const name = reference.repositoryName;
  if (repository?.id !== reference.repositoryId || repository.name !== name || repository.private !== true
      || repository.owner?.id !== viewer.githubUserId || !fits(login, repository.owner?.login)
      || repository.owner.login.toLowerCase() !== owner.toLowerCase()
      || repository.default_branch !== reference.productionBranch
      || !isManagedRepositoryDescription(repository.description, name.slice(4))) return false;

  return matchesApprovedPagesProject(project, { name: name + '-site', owner, ownerId: viewer.githubUserId,
    repositoryName: name, repositoryId: reference.repositoryId, projectId: reference.pagesProjectId,
    branch: reference.productionBranch });
}

function acceptedPublication(reference, proof, now) {
  if (!proof || proof.repositoryId !== reference.repositoryId || proof.pagesProjectId !== reference.pagesProjectId
      || !fits(opaqueId, proof.deploymentId) || !fits(gitSha, proof.approvedCommitSha)
      || !fits(sha256, proof.approvedHtmlSha256) || !fits(sha256, proof.publicHtmlSha256)
      || proof.approvedHtmlSha256.toLowerCase() !== proof.publicHtmlSha256.toLowerCase()
      || !Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt < 1 || proof.verifiedAt > now) return null;
  return { deploymentId: proof.deploymentId, commitSha: proof.approvedCommitSha.toLowerCase(),
    publicHtmlSha256: proof.publicHtmlSha256.toLowerCase(), verifiedAt: proof.verifiedAt };
}

function previewConfiguration(project) {
  switch (project.source.config.preview_deployment_setting) {
    case 'none': return 'disabled';
    case 'custom': return 'custom_branches';
    case 'all': return 'all_branches';
    default: return 'unknown';
  }
}

// Internal projection of current, server-fetched provider evidence. Callers must authenticate
// the session, resolve the site reference on the server, and fence the reads against revocation.
// An approval-history row or a client-supplied ID is not an ownership proof.
export function summarizeOwnedToolkitSite({ viewer, reference, repository, pagesAccountId, pagesProject, publication } = {},
  { now = Math.floor(Date.now() / 1000), editorEligible = false } = {}) {
  if (!matchesOwnedSite(viewer, reference, repository, pagesAccountId, pagesProject)) return null;

  const projectName = reference.repositoryName + '-site';
  const website = `https://${projectName}.pages.dev/`;
  const lastVerified = acceptedPublication(reference, publication, now);
  const canonical = pagesProject.canonical_deployment;
  const commit = canonical?.deployment_trigger?.metadata?.commit_hash;
  const productionCommitSha = canonical?.environment === 'production' && canonical.latest_stage?.name === 'deploy'
    && canonical.latest_stage?.status === 'success' && fits(gitSha, commit) ? commit.toLowerCase() : null;
  const matchesCurrent = lastVerified && productionCommitSha === lastVerified.commitSha
    && canonical?.id === lastVerified.deploymentId;
  const deploymentState = matchesCurrent ? 'verified_deployment' : productionCommitSha
    ? 'production_unverified' : 'production_pending';
  const zipSource = reference.sourceKind === 'uploaded-zip';
  const websiteUpdates = zipSource
    ? { state: 'not_available', reason: 'uploaded_source_has_no_supported_editor' }
    : editorEligible
      ? { state: 'available_opt_in', reason: 'editor_eligible' }
      : { state: 'not_available', reason: 'update_acceptance_pending' };

  return {
    siteId: reference.siteId,
    sourceKind: reference.sourceKind,
    repositoryUrl: `https://github.com/${viewer.githubLogin}/${reference.repositoryName}`,
    pagesProjectUrl: `https://dash.cloudflare.com/${pagesAccountId}/pages/view/${projectName}`,
    deployment: { state: deploymentState, productionCommitSha, lastVerified, verifiedUrl: matchesCurrent ? website : null },
    capabilities: {
      static_hosting: { state: 'included_verified', reason: 'verified_static_pages_project' },
      https: matchesCurrent ? { state: 'included_verified', reason: 'verified_https_publication' }
        : { state: 'not_available', reason: 'awaiting_public_https_verification' },
      deployment_health: { state: 'included_verified', reason: 'verified_pages_project_metadata' },
      website_updates: websiteUpdates,
      web_analytics: { state: 'manual_setup', reason: 'review_provider_settings', activation: 'not_available' },
      pr_previews: { state: 'blocked_permission_or_plan', reason: 'preview_access_and_approval_required',
        configuration: previewConfiguration(pagesProject) },
      custom_domains: { state: 'manual_setup', reason: 'verified_domain_setup_required' },
      email_routing: { state: 'not_available', reason: 'owned_custom_domain_needed' },
      seo_bundle: { state: 'not_available', reason: 'separate_reviewed_artifact_needed' },
      contact_forms: { state: 'not_available', reason: 'verified_server_form_integration_needed' },
      advanced_services: { state: 'not_available', reason: 'separate_usage_and_approval_review_needed' }
    }
  };
}
