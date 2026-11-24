import {matchesApprovedPagesProject} from '../pipeline/approved-pages-project.mjs';
import {classifyPreviewPolicy, previewExposureNotice} from '../pipeline/pages-preview-policy.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPOSITORY = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID = /^[a-z0-9_-]{1,128}$/i;

const POLICY_STATES = Object.freeze({
  off: 'disabled',
  scoped: 'configured-unverified',
  unsafe_all: 'unsafe-configuration',
  unsafe_custom: 'unsafe-configuration',
  unknown: 'unknown-configuration'
});

function snapshotSite(site, principal) {
  const {githubUserId, githubOwner, cloudflareAccountId, repositoryId, repositoryName,
    pagesProjectId, pagesProjectName, branch} = site ?? {};
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0 ||
      principal?.githubUserId !== githubUserId ||
      typeof githubOwner !== 'string' || !OWNER.test(githubOwner) ||
      typeof principal.githubLogin !== 'string' || principal.githubLogin.toLowerCase() !== githubOwner.toLowerCase() ||
      typeof cloudflareAccountId !== 'string' || !ACCOUNT.test(cloudflareAccountId) ||
      principal.cloudflareAccountId !== cloudflareAccountId ||
      !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      typeof repositoryName !== 'string' || !REPOSITORY.test(repositoryName) ||
      typeof pagesProjectId !== 'string' || !PROJECT_ID.test(pagesProjectId) ||
      pagesProjectName !== repositoryName + '-site' || branch !== 'main')
    return null;
  return {githubUserId, githubOwner, cloudflareAccountId, repositoryId, repositoryName,
    pagesProjectId, pagesProjectName, branch};
}

/**
 * Read the build setting from the exact Pages project identified by current
 * managed-site inventory. The caller supplies trusted site/session data and a
 * live authorization fence. Neither Pages Access nor any PR is queried here.
 */
export async function readToolkitPreviewStatus({
  site, principal, cloudflareAccessToken, assertCurrentAuthorization, fetchFn = fetch
} = {}) {
  const trusted = snapshotSite(site, principal);
  if (!trusted) return {state: 'unavailable'};
  if (typeof cloudflareAccessToken !== 'string' || !cloudflareAccessToken.trim() ||
      typeof assertCurrentAuthorization !== 'function')
    return {state: 'reauthorization-required'};

  const identity = Object.freeze({...trusted, githubLogin: principal.githubLogin});
  const sameInputs = () => principal.githubUserId === trusted.githubUserId &&
    principal.githubLogin === identity.githubLogin &&
    principal.cloudflareAccountId === trusted.cloudflareAccountId &&
    Object.keys(trusted).every(key => site[key] === trusted[key]);
  const authorized = async () => {
    try {
      return sameInputs() && await assertCurrentAuthorization(identity) === true && sameInputs();
    } catch {
      return false;
    }
  };
  if (!await authorized()) return {state: 'reauthorization-required'};

  let response;
  try {
    response = await fetchFn('https://api.cloudflare.com/client/v4/accounts/' +
      trusted.cloudflareAccountId + '/pages/projects/' + trusted.pagesProjectName, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {authorization: 'Bearer ' + cloudflareAccessToken, accept: 'application/json'}
    });
  } catch {
    return {state: 'unavailable'};
  }

  if (!await authorized()) return {state: 'reauthorization-required'};
  if (response?.status === 401) return {state: 'reauthorization-required'};
  if (response?.status === 403 && !response.headers?.get('retry-after') &&
      response.headers?.get('x-ratelimit-remaining') !== '0')
    return {state: 'permission-required'};
  if (!response?.ok) return {state: 'unavailable'};

  let body;
  try { body = await response.json(); }
  catch { return {state: 'unavailable'}; }
  if (!await authorized()) return {state: 'reauthorization-required'};

  const project = body?.result;
  if (body?.success !== true || !matchesApprovedPagesProject(project, {
    name: trusted.pagesProjectName, owner: trusted.githubOwner, ownerId: trusted.githubUserId,
    repositoryName: trusted.repositoryName, repositoryId: trusted.repositoryId,
    branch: trusted.branch, projectId: trusted.pagesProjectId
  })) return {state: 'unavailable'};

  return {state: POLICY_STATES[classifyPreviewPolicy(project).state]};
}

const COPY = Object.freeze({
  disabled: [
    'New preview builds are off',
    'Cloudflare reports that preview builds are disabled for this project. Previously built previews can still be reachable.'
  ],
  'configured-unverified': [
    'Preview builds are configured',
    'Cloudflare reports scoped update branches. Access protection and the exact pull request revision still need verification.'
  ],
  'unsafe-configuration': [
    'Preview branch settings need review',
    'The current branch settings differ from the scoped update policy.'
  ],
  'unknown-configuration': [
    'Preview settings are unknown',
    'Check the project’s build settings in Cloudflare.'
  ],
  'permission-required': [
    'Pages read permission required',
    'The connected Cloudflare grant needs permission to read this project’s preview settings.'
  ],
  'reauthorization-required': [
    'Reconnect to check preview settings',
    'Refresh your account connection to check preview settings for this site.'
  ],
  unavailable: [
    'Preview settings unavailable',
    'Try refreshing the site check.'
  ]
});

export function renderToolkitPreviewStatus(result) {
  const state = result?.state;
  const [label, detail] = typeof state === 'string' && Object.hasOwn(COPY, state)
    ? COPY[state] : COPY.unavailable;
  const [exposureNotice] = previewExposureNotice();
  return '<section><h2>Pull request previews</h2><p class="pill">' + label + '</p><p>' + detail +
    '</p><p>' + exposureNotice +
    ' Review an eligible update in Launch &amp; Own before approving it.</p></section>';
}
