/**
 * #87 adapter for #39 read-only current managed-site discovery and sealed
 * reference handoff. GET-only provider reads, fenced against session epoch
 * changes. Never trusts browser-supplied ownership JSON. Never inserts
 * untrusted homepage HTML into the onboarding origin.
 */
import {
  discoverOwnedManagedSites,
  readCurrentManagedHomepage,
  readCurrentManagedSite,
  ManagedSiteInventoryError
} from '../pipeline/owned-site-inventory.mjs';
import {findOwnedLiveToolkitJob, hasCurrentOwnerSession, isLaunchId} from './launch-jobs.mjs';
import {getFreshAccessToken, AuthorizationRefreshBusy} from './token-lifecycle.mjs';
import {loadToolkitAnalytics, renderToolkitAnalytics} from './toolkit-analytics.mjs';
import {readToolkitPreviewStatus, renderToolkitPreviewStatus} from './toolkit-preview.mjs';
import {prepareOptionalExtensionReview} from '../pipeline/optional-service-budget.mjs';
import {renderToolkitUsage} from './toolkit-usage.mjs';
import {seal, unseal} from './crypto.mjs';
import {pagesAccessFetch} from './pages-access.mjs';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const REFERENCE_LIFETIME = 15 * 60;
const SITE_ID = /^managed_[1-9][0-9]*_[a-z0-9_-]{1,128}$/i;
const OPAQUE = /^[a-z0-9_-]{1,128}$/i;
const REPO = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMERIC = /^[1-9][0-9]*$/;
const CHECKS = Object.freeze({deployment: 'Deployment', analytics: 'Web Analytics',
  previews: 'PR previews', usage: 'Plans and limits'});
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

export function createOwnerAuthorizationFence(env, session, clock = nowSeconds) {
  const expected = ownerPrincipalFromSession(session);
  if (!expected) {
    return async () => false;
  }
  const selected = Object.freeze({hash: session.hash, authorization_epoch: session.authorization_epoch,
    github_user_id: expected.githubUserId, cloudflare_account_id: expected.cloudflareAccountId});
  return async (frozen) => {
    if (!frozen || frozen.githubUserId !== expected.githubUserId ||
        frozen.githubLogin !== expected.githubLogin ||
        frozen.cloudflareAccountId !== expected.cloudflareAccountId)
      return false;
    return hasCurrentOwnerSession(env, selected, clock());
  };
}

function ticketAad(session) {
  return 'managed-site-reference:' + session.hash;
}

function referenceFromSite(site) {
  return Object.freeze({
    siteId: site.siteId,
    githubUserId: site.githubUserId,
    githubOwner: site.githubOwner,
    cloudflareAccountId: site.cloudflareAccountId,
    repositoryId: site.repositoryId,
    repositoryName: site.repositoryName,
    pagesProjectId: site.pagesProjectId,
    pagesProjectName: site.pagesProjectName,
    branch: site.branch,
    productionBranch: site.productionBranch,
    sourceKind: site.sourceKind
  });
}

function validReference(reference, principal) {
  return reference && SITE_ID.test(reference.siteId || '') &&
    reference.githubUserId === principal.githubUserId &&
    typeof reference.githubOwner === 'string' &&
    reference.githubOwner.toLowerCase() === principal.githubLogin.toLowerCase() &&
    reference.cloudflareAccountId === principal.cloudflareAccountId &&
    Number.isSafeInteger(reference.repositoryId) &&
    NUMERIC.test(String(reference.repositoryId)) &&
    REPO.test(reference.repositoryName || '') &&
    OPAQUE.test(reference.pagesProjectId || '') &&
    reference.pagesProjectName === reference.repositoryName + '-site' &&
    reference.branch === 'main' && reference.productionBranch === 'main' &&
    reference.sourceKind === 'managed-existing' &&
    reference.siteId === 'managed_' + reference.repositoryId + '_' + reference.pagesProjectId;
}

export async function sealManagedSiteReference(env, session, site, time = Math.floor(Date.now() / 1000)) {
  const principal = ownerPrincipalFromSession(session);
  const reference = referenceFromSite(site);
  if (!principal || !validReference(reference, principal))
    throw new ManagedSiteInventoryError('invalid_managed_identity');
  return seal(env.TOKEN_ENCRYPTION_KEY, JSON.stringify({
    version: 1,
    kind: 'managed-site-reference',
    createdAt: time,
    expiresAt: time + REFERENCE_LIFETIME,
    githubUserId: principal.githubUserId,
    cloudflareAccountId: principal.cloudflareAccountId,
    authorizationEpoch: session.authorization_epoch,
    reference
  }), ticketAad(session));
}

export async function openManagedSiteReference(env, session, raw, time = Math.floor(Date.now() / 1000)) {
  const principal = ownerPrincipalFromSession(session);
  if (!principal || typeof raw !== 'string' || raw.length < 50 || raw.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new ManagedSiteInventoryError('owned_site_not_found');
  let value;
  try {
    value = JSON.parse(await unseal(env.TOKEN_ENCRYPTION_KEY, raw, ticketAad(session)));
  } catch {
    throw new ManagedSiteInventoryError('owned_site_not_found');
  }
  if (value?.kind !== 'managed-site-reference' || value.version !== 1 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt > time ||
      value.createdAt < time - REFERENCE_LIFETIME ||
      value.expiresAt !== value.createdAt + REFERENCE_LIFETIME || value.expiresAt <= time ||
      value.githubUserId !== principal.githubUserId ||
      value.cloudflareAccountId !== principal.cloudflareAccountId ||
      value.authorizationEpoch !== session.authorization_epoch ||
      !validReference(value.reference, principal))
    throw new ManagedSiteInventoryError('owned_site_not_found');
  return Object.freeze(value.reference);
}

async function providerBundle(env, session, {
  clock = nowSeconds, fetchFn = fetch, tokenFetch = getFreshAccessToken,
  githubAccessToken, cloudflareAccessToken
} = {}) {
  const authorize = createOwnerAuthorizationFence(env, session, clock);
  const checkSession = async () => {
    if (!await authorize(ownerPrincipalFromSession(session)))
      throw new ManagedSiteInventoryError('authorization_changed');
  };
  const fencedFetch = async (url, options = {}) => {
    await checkSession();
    return await fetchFn(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10000)
    });
  };
  await checkSession();
  try {
    const github = githubAccessToken || await tokenFetch({
      env, session, provider: 'github', fetchFn: fencedFetch
    });
    const cloudflare = cloudflareAccessToken || await tokenFetch({
      env, session, provider: 'cloudflare', fetchFn: fencedFetch
    });
    const pages = await pagesAccessFetch(env, session, fetchFn, {now: clock});
    // Provider readers fence each request. Fence refresh requests here.
    return {
      async checkSession() {
        await checkSession();
        if (!await pages.isCurrent()) throw new ManagedSiteInventoryError('authorization_changed');
      },
      githubAccessToken: github,
      cloudflareAccessToken: cloudflare,
      fetchFn: pages.fetchFn,
      assertCurrentAuthorization: async owner => await authorize(owner) && await pages.isCurrent()
    };
  } catch (error) {
    if (error instanceof ManagedSiteInventoryError) throw error;
    throw new ManagedSiteInventoryError(error instanceof AuthorizationRefreshBusy
      ? 'provider_refresh_in_progress' : 'provider_reauthorization_required');
  }
}

/**
 * @returns {Promise<{status:'ok', page:number, nextPage:number|null, sites:object[]}|
 *   {status:'unavailable', code:string}>}
 */
export async function loadCurrentManagedSitesPage(env, session, {
  page = 1, clock = nowSeconds, fetchFn = fetch, githubAccessToken, cloudflareAccessToken
} = {}) {
  const principal = ownerPrincipalFromSession(session);
  if (!principal)
    return {status: 'unavailable', code: 'verified_owner_required'};
  if (!Number.isSafeInteger(page) || page < 1)
    return {status: 'unavailable', code: 'invalid_inventory_page'};
  if (typeof githubAccessToken !== 'string' || !githubAccessToken ||
      typeof cloudflareAccessToken !== 'string' || !cloudflareAccessToken)
    return {status: 'unavailable', code: 'provider_reauthorization_required'};

  try {
    const authorize = createOwnerAuthorizationFence(env, session, clock);
    const pages = await pagesAccessFetch(env, session, fetchFn, {now: clock});
    const inventory = await discoverOwnedManagedSites({
      page,
      principal,
      githubAccessToken,
      cloudflareAccessToken,
      assertCurrentAuthorization: async owner => await authorize(owner) && await pages.isCurrent(),
      fetchFn: pages.fetchFn
    });
    const sites = [];
    for (const site of inventory.sites) {
      const ticket = await sealManagedSiteReference(env, session, site, clock());
      sites.push(Object.freeze({...site, sourceTicket: ticket}));
    }
    if (!await authorize(principal) || !await pages.isCurrent())
      throw new ManagedSiteInventoryError('authorization_changed');
    return {
      status: 'ok',
      page: inventory.page,
      nextPage: inventory.nextPage,
      coverage: inventory.coverage,
      sites: Object.freeze(sites)
    };
  } catch (error) {
    const code = error instanceof ManagedSiteInventoryError
      ? error.code
      : 'current_inventory_unavailable';
    return {status: 'unavailable', code};
  }
}

/**
 * Check one dashboard view for a sealed reference. Separate requests keep
 * provider reads bounded even when credentials need renewal. Return display
 * metadata only and keep private homepage bytes on the server.
 */
export async function inspectSealedManagedSource(env, session, ticketRaw, {
  check = 'deployment',
  clock = nowSeconds,
  fetchFn = fetch,
  tokenFetch = getFreshAccessToken,
  githubAccessToken,
  cloudflareAccessToken
} = {}) {
  const principal = ownerPrincipalFromSession(session);
  if (!principal)
    return {status: 'unavailable', code: 'verified_owner_required'};
  if (!Object.hasOwn(CHECKS, check))
    return {status: 'unavailable', code: 'invalid_toolkit_check'};
  try {
    const reference = await openManagedSiteReference(env, session, ticketRaw, clock());
    const bundle = await providerBundle(env, session, {
      clock, fetchFn, tokenFetch, githubAccessToken, cloudflareAccessToken
    });
    const request = {siteId: reference.siteId, reference, principal, fetchFn: bundle.fetchFn,
      githubAccessToken: bundle.githubAccessToken,
      cloudflareAccessToken: bundle.cloudflareAccessToken,
      assertCurrentAuthorization: bundle.assertCurrentAuthorization};
    const name = reference.repositoryName.slice(4).replaceAll('-', ' ');
    const display = {status: 'ok', check, name: name[0].toUpperCase() + name.slice(1),
      repositoryUrl: 'https://github.com/' + reference.githubOwner + '/' + reference.repositoryName,
      pagesProjectUrl: 'https://dash.cloudflare.com/' + reference.cloudflareAccountId +
        '/pages/view/' + reference.pagesProjectName};
    if (check !== 'deployment') {
      const site = await readCurrentManagedSite(request);
      if (check === 'usage') {
        const feature = await prepareOptionalExtensionReview({site, principal}, {
          now: clock(), assertCurrentAuthorization: () => bundle.assertCurrentAuthorization(principal)
        });
        await bundle.checkSession();
        return {...display, feature};
      }
      const keys = ['githubUserId', 'githubOwner', 'cloudflareAccountId', 'repositoryId',
        'repositoryName', 'pagesProjectId', 'pagesProjectName', 'branch'];
      const featureRequest = {site, principal, cloudflareAccessToken: bundle.cloudflareAccessToken, fetchFn: bundle.fetchFn,
        assertCurrentAuthorization: identity => {
          // Both feature readers pass a frozen snapshot of the scoped site.
          return Boolean(identity && keys.every(key => identity[key] === site[key])) &&
            bundle.assertCurrentAuthorization(principal);
        }};
      const feature = check === 'analytics' ? await loadToolkitAnalytics(featureRequest)
        : await readToolkitPreviewStatus(featureRequest);
      await bundle.checkSession();
      return {...display, feature};
    }
    const source = await readCurrentManagedHomepage({...request, includePublication: true});
    const launch = await findOwnedLiveToolkitJob(env, session, reference, clock());
    await bundle.checkSession();
    const jobId = isLaunchId(launch?.id) ? encodeURIComponent(launch.id) : null;
    return {
      ...display,
      siteId: source.siteId,
      editPath: jobId && launch.can_edit ? '/site-update?id=' + jobId : null,
      optionsPath: jobId ? '/site-options?id=' + jobId : null,
      publicationCheck: source.publicationCheck,
      baseCommitSha: source.baseCommitSha,
      homepageHtmlSha256: source.homepageHtmlSha256,
      homepageGitBlobSha: source.homepageGitBlobSha,
      publicationVerified: source.publicationVerified,
      historicalContinuityVerified: source.historicalContinuityVerified,
      editMode: source.editMode
      // deliberately omit source.html
    };
  } catch (error) {
    const code = error instanceof ManagedSiteInventoryError
      ? error.code
      : 'current_source_unavailable';
    return {status: 'unavailable', code};
  }
}

/** Found sites that match a launch card are shown inside that card; only the rest are listed here. */
export function renderCurrentSitesSection(inventory, {escape}, {matched = new Set(), hasCards = false} = {}) {
  if (!inventory || inventory.status === 'unavailable') {
    const code = inventory?.code ? ' (' + escape(inventory.code) + ')' : '';
    return '<section><h2>Sites we found in your accounts</h2>' +
      '<p class="muted">Could not refresh that list right now' + code +
      '. Your launches above are unchanged.</p></section>';
  }
  const all = inventory.sites || [];
  const sites = all.filter(site => !matched.has(site.repositoryName));
  const pagerOnly = inventory.nextPage
    ? '<p><a href="/toolkit?page=' + encodeURIComponent(String(inventory.nextPage)) + '">Show more sites</a></p>' : '';
  if ((all.length || hasCards) && !sites.length) return pagerOnly;
  const body = !sites.length
    ? '<p>No Launch &amp; Own sites showed up in this Cloudflare page.</p>'
    : sites.map(site => renderCurrentSite(site, escape)).join('');
  const pager = inventory.nextPage
    ? '<p><a href="/toolkit?page=' + encodeURIComponent(String(inventory.nextPage)) +
      '">Show more sites</a></p>'
    : '';
  return '<section><h2>' + (matched.size || hasCards ? 'Other sites in your accounts' : 'Sites we found in your accounts') + '</h2>' +
    '<p>Choose a site to check its current deployment and settings.</p>' +
    body + pager + '</section>';
}

function renderCurrentSite(site, escape) {
  const name = site.repositoryName?.startsWith('esp-')
    ? site.repositoryName.slice(4)
    : site.repositoryName;
  return '<article class="tk-site"><h3>' + escape(name || site.siteId) + '</h3>' +
    '<p class="pill">Live content not re-checked here</p>' + currentSiteDetails(site, escape) + '</article>';
}

/** GitHub, Cloudflare and version details for one found site, for its toolkit card. */
export function currentSiteDetails(site, escape) {
  const repo = site.repositoryUrl
    ? '<p>Private files: <a href="' + escape(site.repositoryUrl) +
      '" rel="noopener">Open on GitHub</a></p>'
    : '';
  const pages = site.pagesProjectDashboardUrl
    ? '<p>Hosting project: <a href="' + escape(site.pagesProjectDashboardUrl) +
      '" rel="noopener">Open in Cloudflare</a></p>'
    : '';
  const sha = site.baseCommitSha
    ? '<p>Current private-files version: <code>' + escape(site.baseCommitSha) + '</code></p>'
    : '';
  const observed = site.productionCommitSha
    ? '<p class="muted">Reported production version <code>' +
      escape(site.productionCommitSha) + '</code></p>'
    : '<p class="muted">No finished production publish showed up in project details.</p>';
  const source = site.sourceTicket
    ? '<p><a href="/toolkit/source?ticket=' + encodeURIComponent(site.sourceTicket) +
      '">Open site toolkit</a></p>'
    : '';
  return repo + pages + sha + observed + source;
}

const DEPLOYMENT_COPY = Object.freeze({
  verified_homepage: 'The public homepage matches the current file in GitHub.',
  waiting_for_current_deployment: 'Cloudflare has yet to publish the current GitHub version.',
  deployment_failed: 'Cloudflare reported a failed production deployment for this GitHub version.',
  deployment_changed: 'The production deployment changed during this check. Refresh for the latest result.',
  public_content_differs: 'The public homepage differs from the current file in GitHub.',
  public_check_unavailable: 'We could not confirm the public homepage. Try again later.'
});

function renderDeployment(inspection, escape) {
  const result = inspection.publicationCheck;
  const verified = result?.state === 'verified_homepage';
  const message = result && Object.hasOwn(DEPLOYMENT_COPY, result.state)
    ? DEPLOYMENT_COPY[result.state] : 'We checked the current homepage file in GitHub.';
  const production = result?.productionCommitSha
    ? '<p>Production version <code>' + escape(result.productionCommitSha) + '</code></p>' : '';
  const checkedAt = verified ? new Date(result.checkedAt * 1000).toISOString() : null;
  const website = verified
    ? '<p><a href="' + escape(result.verifiedUrl) + '" rel="noreferrer">Open verified homepage</a></p>' +
      '<p>Checked <time datetime="' + checkedAt + '">' + checkedAt.slice(0, 16).replace('T', ' ') + ' UTC</time></p>' : '';
  const actions = (inspection.editPath
    ? '<p><a href="' + escape(inspection.editPath) + '">Update this website</a></p>'
    : inspection.repositoryUrl
      ? '<p>Open your files on GitHub for edits outside the one-page editor.</p>' : '') +
    (inspection.optionsPath
      ? '<p><a href="' + escape(inspection.optionsPath) + '">Review optional features</a></p>' : '');
  return '<section><h2>Deployment</h2><p role="status">' + message + '</p>' +
    production + website + actions +
    '<details><summary>Technical details</summary>' +
    '<p>Current GitHub version <code>' + escape(inspection.baseCommitSha) + '</code></p>' +
    '<p>Homepage fingerprint <code>' + escape(inspection.homepageHtmlSha256) + '</code></p>' +
    '<p>Git file ID <code>' + escape(inspection.homepageGitBlobSha) + '</code></p>' +
    '<p>Editor mode <code>' + escape(inspection.editMode) + '</code></p>' +
    '</details></section>';
}

export function renderCurrentSourcePage(inspection, {view, escape}, ticket = '') {
  const back = '<p><a href="/toolkit">Back to toolkit</a></p>';
  if (!inspection || inspection.status !== 'ok') {
    const code = inspection?.code ? ' (' + escape(inspection.code) + ')' : '';
    return view('Site toolkit',
      '<p>That check is unavailable or expired' + code + '.</p>' + back);
  }
  const tabs = ticket ? '<nav aria-label="Site toolkit" style="display:flex;flex-wrap:wrap;gap:.5rem 1rem">' +
    Object.entries(CHECKS).map(([check, label]) => {
      const selected = inspection.check === check;
      return '<a href="/toolkit/source?ticket=' + encodeURIComponent(ticket) +
        '&amp;check=' + check + '"' + (selected ? ' aria-current="page">' +
        '<strong>' + label + '</strong>' : '>' + label) + '</a>';
    }).join('') + '</nav>' : '';
  const providers = (inspection.repositoryUrl
    ? '<a href="' + escape(inspection.repositoryUrl) + '" rel="noreferrer">Open on GitHub</a>' : '') +
    (inspection.pagesProjectUrl
      ? ' · <a href="' + escape(inspection.pagesProjectUrl) + '" rel="noreferrer">Open in Cloudflare</a>' : '');
  const render = {
    analytics: () => renderToolkitAnalytics(inspection.feature, {escape}),
    previews: () => renderToolkitPreviewStatus(inspection.feature),
    usage: () => renderToolkitUsage(inspection.feature, {escape})
  };
  const content = Object.hasOwn(render, inspection.check)
    ? render[inspection.check]() : renderDeployment(inspection, escape);
  return view(inspection.name ? inspection.name + ' toolkit' : 'Site toolkit',
    tabs + (providers ? '<p>' + providers + '</p>' : '') + content + back);
}
