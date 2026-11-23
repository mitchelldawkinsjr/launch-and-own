/**
 * #87 adapter for #39 read-only current managed-site discovery.
 * GET-only provider reads, fenced against session epoch changes. Does not claim
 * public HTML/HTTPS verification or invent live website URLs.
 */
import {
  discoverOwnedManagedSites,
  ManagedSiteInventoryError
} from '../pipeline/owned-site-inventory.mjs';
import {hasCurrentOwnerSession} from './launch-jobs.mjs';
import {getFreshAccessToken} from './token-lifecycle.mjs';

export function ownerPrincipalFromSession(session) {
  if (!session || !Number.isSafeInteger(session.github_user_id) || session.github_user_id < 1 ||
      typeof session.github_login !== 'string' ||
      typeof session.cloudflare_account_id !== 'string')
    return null;
  return Object.freeze({
    githubUserId: session.github_user_id,
    githubLogin: session.github_login,
    cloudflareAccountId: session.cloudflare_account_id
  });
}

export function createOwnerAuthorizationFence(env, session, time) {
  const expected = ownerPrincipalFromSession(session);
  if (!expected) {
    return async () => false;
  }
  return async (frozen) => {
    if (!frozen || frozen.githubUserId !== expected.githubUserId ||
        frozen.githubLogin !== expected.githubLogin ||
        frozen.cloudflareAccountId !== expected.cloudflareAccountId)
      return false;
    return hasCurrentOwnerSession(env, session, time);
  };
}

/**
 * @returns {Promise<{status:'ok', page:number, nextPage:number|null, sites:object[]}|
 *   {status:'unavailable', code:string}>}
 */
export async function loadCurrentManagedSitesPage(env, session, {
  page = 1,
  time = Math.floor(Date.now() / 1000),
  fetchFn = fetch,
  tokenFetch = getFreshAccessToken
} = {}) {
  const principal = ownerPrincipalFromSession(session);
  if (!principal)
    return {status: 'unavailable', code: 'verified_owner_required'};
  if (!Number.isSafeInteger(page) || page < 1)
    return {status: 'unavailable', code: 'invalid_inventory_page'};

  try {
    const checkSession = async () => {
      if (!await hasCurrentOwnerSession(env, session, time))
        throw new ManagedSiteInventoryError('authorization_changed');
    };
    const fencedFetch = async (url, options = {}) => {
      await checkSession();
      return await fetchFn(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(10000)
      });
    };
    const githubAccessToken = await tokenFetch({
      env, session, provider: 'github', fetchFn: fencedFetch
    });
    const cloudflareAccessToken = await tokenFetch({
      env, session, provider: 'cloudflare', fetchFn: fencedFetch
    });
    const inventory = await discoverOwnedManagedSites({
      page,
      principal,
      githubAccessToken,
      cloudflareAccessToken,
      assertCurrentAuthorization: createOwnerAuthorizationFence(env, session, time),
      fetchFn: fencedFetch
    });
    await checkSession();
    return {
      status: 'ok',
      page: inventory.page,
      nextPage: inventory.nextPage,
      coverage: inventory.coverage,
      sites: inventory.sites
    };
  } catch (error) {
    const code = error instanceof ManagedSiteInventoryError
      ? error.code
      : 'current_inventory_unavailable';
    return {status: 'unavailable', code};
  }
}

export function renderCurrentSitesSection(inventory, {escape}) {
  if (!inventory || inventory.status === 'unavailable') {
    const code = inventory?.code ? ' (' + escape(inventory.code) + ')' : '';
    return '<section><h2>Current managed sites</h2>' +
      '<p class="muted">Could not refresh provider inventory right now' + code +
      '. Launch history above is unchanged.</p></section>';
  }
  const sites = inventory.sites || [];
  const body = !sites.length
    ? '<p>No managed Launch &amp; Own sites found on this Cloudflare Pages page.</p>'
    : sites.map(site => renderCurrentSite(site, escape)).join('');
  const pager = inventory.nextPage
    ? '<p><a href="/toolkit?page=' + encodeURIComponent(String(inventory.nextPage)) +
      '">Next provider page</a></p>'
    : '';
  return '<section><h2>Current managed sites</h2>' +
    '<p>Read-only discovery from your connected GitHub and Cloudflare account. ' +
    'Public HTML is <strong>not</strong> re-verified here; treat dashboard and GitHub links as ownership evidence only.</p>' +
    body + pager + '</section>';
}

function renderCurrentSite(site, escape) {
  const name = site.repositoryName?.startsWith('esp-')
    ? site.repositoryName.slice(4)
    : site.repositoryName;
  const repo = site.repositoryUrl
    ? '<p>Private code: <a href="' + escape(site.repositoryUrl) +
      '" rel="noopener">Open GitHub repository</a></p>'
    : '';
  const pages = site.pagesProjectDashboardUrl
    ? '<p>Pages project: <a href="' + escape(site.pagesProjectDashboardUrl) +
      '" rel="noopener">Open Cloudflare dashboard</a></p>'
    : '';
  const sha = site.baseCommitSha
    ? '<p>Current GitHub <code>main</code>: <code>' + escape(site.baseCommitSha) + '</code></p>'
    : '';
  const observed = site.productionCommitSha
    ? '<p class="muted">Observed Pages production commit (unverified public HTML): <code>' +
      escape(site.productionCommitSha) + '</code></p>'
    : '<p class="muted">No successful production deployment observed in project metadata.</p>';
  return '<article><h3>' + escape(name || site.siteId) + '</h3>' +
    '<p class="pill">Publication unverified</p>' +
    '<p>Historical continuity with launch history is not proven for this discovery.</p>' +
    repo + pages + sha + observed + '</article>';
}
