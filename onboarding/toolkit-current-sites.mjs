/**
 * #87 adapter for #39 read-only current managed-site discovery and sealed
 * reference handoff. GET-only provider reads, fenced against session epoch
 * changes. Never trusts browser-supplied ownership JSON. Never inserts
 * untrusted homepage HTML into the onboarding origin.
 */
import {
  discoverOwnedManagedSites,
  readCurrentManagedHomepage,
  ManagedSiteInventoryError
} from '../pipeline/owned-site-inventory.mjs';
import {hasCurrentOwnerSession} from './launch-jobs.mjs';
import {getFreshAccessToken} from './token-lifecycle.mjs';
import {seal, unseal} from './crypto.mjs';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const REFERENCE_LIFETIME = 15 * 60;
const SITE_ID = /^managed_[1-9][0-9]*_[a-z0-9_-]{1,128}$/i;
const OPAQUE = /^[a-z0-9_-]{1,128}$/i;
const REPO = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMERIC = /^[1-9][0-9]*$/;
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
  return value.reference;
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
  const github = githubAccessToken || await tokenFetch({
    env, session, provider: 'github', fetchFn: fencedFetch
  });
  const cloudflare = cloudflareAccessToken || await tokenFetch({
    env, session, provider: 'cloudflare', fetchFn: fencedFetch
  });
  return {
    checkSession,
    fencedFetch,
    githubAccessToken: github,
    cloudflareAccessToken: cloudflare,
    assertCurrentAuthorization: authorize
  };
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
    const inventory = await discoverOwnedManagedSites({
      page,
      principal,
      githubAccessToken,
      cloudflareAccessToken,
      assertCurrentAuthorization: createOwnerAuthorizationFence(env, session, clock),
      fetchFn
    });
    const sites = [];
    for (const site of inventory.sites) {
      const ticket = await sealManagedSiteReference(env, session, site, clock());
      sites.push(Object.freeze({...site, sourceTicket: ticket}));
    }
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
 * Inspect current GitHub homepage bytes for a sealed reference.
 * Returns metadata only — never the raw HTML for browser embedding.
 */
export async function inspectSealedManagedSource(env, session, ticketRaw, {
  clock = nowSeconds,
  fetchFn = fetch,
  tokenFetch = getFreshAccessToken,
  githubAccessToken,
  cloudflareAccessToken
} = {}) {
  const principal = ownerPrincipalFromSession(session);
  if (!principal)
    return {status: 'unavailable', code: 'verified_owner_required'};
  try {
    const reference = await openManagedSiteReference(env, session, ticketRaw, clock());
    const bundle = await providerBundle(env, session, {
      clock, fetchFn, tokenFetch, githubAccessToken, cloudflareAccessToken
    });
    const source = await readCurrentManagedHomepage({
      siteId: reference.siteId,
      reference,
      principal,
      githubAccessToken: bundle.githubAccessToken,
      cloudflareAccessToken: bundle.cloudflareAccessToken,
      assertCurrentAuthorization: bundle.assertCurrentAuthorization,
      fetchFn: bundle.fencedFetch
    });
    await bundle.checkSession();
    return {
      status: 'ok',
      siteId: source.siteId,
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
  const source = site.sourceTicket
    ? '<p><a href="/toolkit/source?ticket=' + encodeURIComponent(site.sourceTicket) +
      '">Inspect current GitHub source fingerprint</a></p>'
    : '';
  return '<article><h3>' + escape(name || site.siteId) + '</h3>' +
    '<p class="pill">Publication unverified</p>' +
    '<p>Historical continuity with launch history is not proven for this discovery.</p>' +
    repo + pages + sha + observed + source + '</article>';
}

export function renderCurrentSourcePage(inspection, {view, escape}) {
  if (!inspection || inspection.status !== 'ok') {
    const code = inspection?.code ? ' (' + escape(inspection.code) + ')' : '';
    return view('Current GitHub source',
      '<p>That source inspection is unavailable or expired' + code + '.</p>' +
      '<p><a href="/toolkit">Back to toolkit</a></p>');
  }
  return view('Current GitHub source',
    '<p>Server-verified GitHub <code>public/index.html</code> fingerprint for a sealed ownership reference. ' +
    'This is <strong>not</strong> a live public website check and does not unlock editing.</p>' +
    '<p class="pill">editMode: ' + escape(inspection.editMode) + '</p>' +
    '<p>Site selector: <code>' + escape(inspection.siteId) + '</code></p>' +
    '<p>GitHub <code>main</code>: <code>' + escape(inspection.baseCommitSha) + '</code></p>' +
    '<p>Homepage SHA-256: <code>' + escape(inspection.homepageHtmlSha256) + '</code></p>' +
    '<p>Git blob SHA: <code>' + escape(inspection.homepageGitBlobSha) + '</code></p>' +
    '<p class="muted">publicationVerified=' + escape(String(inspection.publicationVerified)) +
    ' · historicalContinuityVerified=' +
    escape(String(inspection.historicalContinuityVerified)) + '</p>' +
    '<p><a href="/toolkit">Back to toolkit</a></p>');
}
