// Read-only Pages preview configuration and owner review plan (#86).
import {matchesApprovedPagesProject} from './approved-pages-project.mjs';

export const UPDATE_BRANCH_PATTERN = 'launch-and-own/site-*';
const accountId = /^[a-f0-9]{32}$/i;
const patterns = list => Array.isArray(list) && list.every(value => typeof value === 'string')
  ? [...list].sort() : null;

export function classifyPreviewPolicy(project) {
  const config = project?.source?.type === 'github' ? project.source.config : null;
  const includes = patterns(config?.preview_branch_includes);
  const excludes = patterns(config?.preview_branch_excludes);
  const prCommentsEnabled = typeof config?.pr_comments_enabled === 'boolean' ? config.pr_comments_enabled : null;
  const setting = typeof config?.preview_deployment_setting === 'string' ? config.preview_deployment_setting : null;
  const scoped = includes?.length === 1 && includes[0] === UPDATE_BRANCH_PATTERN &&
    excludes?.length === 1 && excludes[0] === 'main' && prCommentsEnabled === false;
  let state = 'unknown';
  if (setting === 'none') state = 'off';
  if (setting === 'all') state = 'unsafe_all';
  if (setting === 'custom') state = scoped ? 'scoped' : 'unsafe_custom';
  return {
    state, setting, includes, excludes, prCommentsEnabled,
    protection: 'unverified',
    capability: state === 'unknown' ? 'not_available' : 'blocked_permission_or_plan'
  };
}

export function planPreviewPolicy(project, {site, pagesAccountId, action} = {}) {
  if (typeof pagesAccountId !== 'string' || !accountId.test(pagesAccountId) ||
      pagesAccountId !== site?.cloudflareAccountId ||
      !Number.isSafeInteger(site.githubUserId) || site.githubUserId < 1 ||
      !Number.isSafeInteger(site.repositoryId) || site.repositoryId < 1 ||
      typeof site.projectId !== 'string' || !site.projectId ||
      typeof site.repositoryName !== 'string' || !/^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(site.repositoryName) ||
      site.branch !== 'main' || !matchesApprovedPagesProject(project, {
        name: site.repositoryName + '-site', owner: site.githubOwner, ownerId: site.githubUserId,
        repositoryName: site.repositoryName, repositoryId: site.repositoryId,
        branch: site.branch, projectId: site.projectId
      })) throw Error('Pages project no longer matches the verified managed site');
  if (action !== 'enable_scoped' && action !== 'disable') throw Error('Unknown preview policy action');

  const before = classifyPreviewPolicy(project);
  const enable = action === 'enable_scoped';
  const proposed = {
    setting: enable ? 'custom' : 'none',
    includes: enable ? [UPDATE_BRANCH_PATTERN] : [],
    excludes: enable ? ['main'] : [],
    prCommentsEnabled: false
  };
  return {
    state: 'review_only', cloudflareAccountId: pagesAccountId, pagesProjectId: site.projectId,
    repositoryId: site.repositoryId, action, before, proposed, protection: 'unverified'
  };
}

export function previewExposureNotice() {
  return [
    'Cloudflare Pages previews are public by default. Confirm Access protection before building a preview.',
    'Scoped builds use Launch & Own update branches. Each build counts toward the Pages allowance.',
    'Turning off builds leaves existing preview deployments in place. Keep their Access protection and review retained URLs.'
  ];
}
