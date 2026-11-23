// #88 / Agent 2: backend-only Cloudflare Pages / Email Routing provider adapter.
// Safe by default: all writes disabled unless caller explicitly wires a separately
// operator-authorized, single-winner execution lease. NO DNS, MX, NS, mailbox or
// billing endpoints. #89 forms methods (Turnstile widget, customer D1, form Worker)
// are reachable only through the same per-request operator approval callback.
import {formsResourceNames, formWorkerUpload, CUSTOMER_FORM_SCHEMA_SQL, FORM_WORKER_CRON,
  PLATFORM_D1_IDS, ACCEPTANCE_SQL} from './forms-provider-plan.mjs';
const ACCOUNT = /^[a-f0-9]{32}$/i;
const NAME = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*-site$/;
const ZONE = /^[a-f0-9]{32}$/i;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;
const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const MAX_GETS = 24;

export class ExtensionProviderError extends Error {
  constructor(code) {
    super('Provider operation unavailable (' + code + ')');
    this.name = 'ExtensionProviderError';
    this.code = code;
  }
}
const deny = code => {throw new ExtensionProviderError(code);};
const lower = s => typeof s === 'string' ? s.toLowerCase() : '';

function safeSite(site, principal) {
  if (site?.cloudflareAccountId !== principal.cloudflareAccountId ||
      site?.githubUserId !== principal.githubUserId ||
      lower(site?.githubLogin) !== lower(principal.githubLogin) ||
      !NAME.test(site?.pagesProjectName || '') ||
      site?.repositoryName + '-site' !== site.pagesProjectName ||
      site?.productionBranch !== 'main')
    deny('owned_project_required');
}
function exactHost(s) {
  if (typeof s !== 'string' || s !== lower(s) ||
      !HOST.test(s) || s.endsWith('.pages.dev') ||
      s.length > 253 || s.includes('*'))
    deny('valid_hostname_required');
  return s;
}
function safePage(data) {
  const info = data?.result_info;
  const length = data?.result?.length;
  // Cloudflare's actual Email Routing list responses return total_count but
  // may omit total_pages. Accept either completeness proof, never a partial
  // first page or missing pagination metadata (which could hide conflicts).
  if (!Array.isArray(data?.result) || length > 50 ||
      !Number.isSafeInteger(info?.page) || info.page !== 1 ||
      (info.total_pages === undefined && info.total_count === undefined) ||
      (info.total_pages !== undefined &&
        (!Number.isSafeInteger(info.total_pages) || info.total_pages !== 1)) ||
      (info.total_count !== undefined &&
        (!Number.isSafeInteger(info.total_count) || info.total_count !== length)) ||
      (info.count !== undefined &&
        (!Number.isSafeInteger(info.count) || info.count !== length)))
    deny('provider_list_incomplete');
  return data.result;
}

/**
 * Tokens must come from a freshly authenticated backend session, not model or
 * browser input. get writes a GET with bounded retries (none) and no redirects.
 * Mutations are disabled by default and require explicit trusted caller opt-in
 * after CAS operator authorization; caller must recheck session around each call.
 */
export function createCloudflareExtensionProvider({
  principal, cloudflareAccessToken, githubAccessToken,
  fetchFn = fetch, assertOperatorApprovedExecution
} = {}) {
  if (!Number.isSafeInteger(principal?.githubUserId) || principal.githubUserId <= 0 ||
      !LOGIN.test(principal.githubLogin || '') ||
      !ACCOUNT.test(principal.cloudflareAccountId || '') ||
      typeof cloudflareAccessToken !== 'string' || !cloudflareAccessToken ||
      typeof githubAccessToken !== 'string' || !githubAccessToken ||
      typeof fetchFn !== 'function')
    deny('provider_session_required');
  const owner = Object.freeze({...principal});
  const verifiedZoneIds = new Set();
  let getCount = 0;
  const authorized = () => {
    if (principal.githubUserId !== owner.githubUserId ||
        principal.githubLogin !== owner.githubLogin ||
        principal.cloudflareAccountId !== owner.cloudflareAccountId)
      deny('authorization_changed');
  };
  async function request(provider, method, path, body, {allow404 = false, approvalBody} = {}) {
    authorized();
    if (method === 'GET') {
      if (++getCount > MAX_GETS) deny('provider_request_budget_exceeded');
    } else {
      if (!['POST', 'PUT'].includes(method)) deny('unsupported_mutation');
      if (typeof assertOperatorApprovedExecution !== 'function')
        deny('separate_execution_approval_required');
      let allowed = false;
      try {
        allowed = await assertOperatorApprovedExecution({
          // Secrets never reach the approval callback; callers pass a redacted view.
          principal: owner, provider, method, path, requestBody: approvalBody ?? body
        });
      } catch {}
      if (allowed !== true) deny('separate_execution_approval_required');
      authorized();
    }
    const token = provider === 'github' ? githubAccessToken : cloudflareAccessToken;
    const url = (provider === 'github'
      ? 'https://api.github.com' : 'https://api.cloudflare.com/client/v4') + path;
    let response;
    try {
      response = await fetchFn(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + token,
          accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json',
          ...(provider === 'github' ? {
            'user-agent': 'launch-and-own', 'x-github-api-version': '2022-11-28'
          } : {}),
          ...(method !== 'GET' && !(body instanceof FormData) ? {'content-type': 'application/json'} : {})
        },
        ...(method !== 'GET' ? {body: body instanceof FormData ? body : JSON.stringify(body)} : {})
      });
    } catch { deny('provider_temporarily_unavailable'); }
    authorized();
    if (response?.status === 404 && allow404) return null;
    if (response?.status === 401) deny('provider_reauthentication_required');
    if (response?.status === 403) deny('provider_permission_required');
    if (response?.status === 429) deny('provider_rate_limited');
    if (!response?.ok || response.status >= 300)
      deny('provider_operation_failed');
    let data;
    try { data = await response.json(); }
    catch { deny('provider_malformed_response'); }
    authorized();
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (provider === 'cloudflare' && data.success !== true))
      deny('provider_malformed_response');
    return provider === 'cloudflare' ? data : data;
  }
  const cfGet = (path, opts) => request('cloudflare', 'GET', path, undefined, opts);
  const cfPost = (path, body, opts) => request('cloudflare', 'POST', path, body, opts);
  const cfPut = (path, body, opts) => request('cloudflare', 'PUT', path, body, opts);
  const accountRoot = () => '/accounts/' + owner.cloudflareAccountId;
  function formsTarget(site, hostname) {
    safeSite(site, owner);
    if (hostname !== site.pagesProjectName + '.pages.dev') deny('forms_hostname_not_active');
    return formsResourceNames(site.pagesProjectName);
  }
  const exactNamed = (list, name) => list.filter(x => x?.name === name);

  function pagesRoot(site) {
    safeSite(site, owner);
    return '/accounts/' + owner.cloudflareAccountId + '/pages/projects/' +
      encodeURIComponent(site.pagesProjectName);
  }

  return Object.freeze({
    async readPagesProject(site) {
      return (await cfGet(pagesRoot(site)))?.result;
    },
    async readGithubRepository(site) {
      safeSite(site, owner);
      return await request('github', 'GET', '/repos/' +
        encodeURIComponent(owner.githubLogin) + '/' +
        encodeURIComponent(site.repositoryName));
    },
    async readGithubBranchHead(site) {
      safeSite(site, owner);
      return await request('github', 'GET', '/repos/' +
        encodeURIComponent(owner.githubLogin) + '/' +
        encodeURIComponent(site.repositoryName) + '/branches/main');
    },
    async readPagesDomain(site, hostname) {
      const host = exactHost(hostname);
      return (await cfGet(pagesRoot(site) + '/domains/' +
        encodeURIComponent(host), {allow404:true}))?.result || null;
    },
    async attachPagesDomain(site, requested) {
      const host = exactHost(requested?.name);
      const data = await cfPost(pagesRoot(site) + '/domains', {name: host});
      if (data?.result?.name !== host) deny('pages_attach_unverified');
      return data.result;
    },
    async readOwnedZone(site, hostname) {
      safeSite(site, owner);
      const host = exactHost(hostname);
      const zones = safePage(await cfGet('/zones?account.id=' +
        encodeURIComponent(owner.cloudflareAccountId) + '&page=1&per_page=50'));
      const candidates = zones.filter(z =>
        ZONE.test(z?.id || '') &&
        z.account?.id === owner.cloudflareAccountId &&
        z.status === 'active' &&
        typeof z.name === 'string' && (host === z.name || host.endsWith('.' + z.name)));
      candidates.sort((a,b)=>b.name.length-a.name.length);
      if (!candidates.length ||
          (candidates.length > 1 && candidates[0].name.length === candidates[1].name.length))
        deny('owned_zone_required');
      verifiedZoneIds.add(candidates[0].id);
      return candidates[0];
    },
    async readEmailRoutingSettings(zoneId) {
      if (!verifiedZoneIds.has(zoneId)) deny('owned_zone_required');
      return (await cfGet('/zones/' + zoneId + '/email/routing'))?.result;
    },
    async readRoutingMxRecords(zoneId, hostname) {
      if (!verifiedZoneIds.has(zoneId)) deny('owned_zone_required');
      const host = exactHost(hostname);
      // An apex Email Routing "ready" setting does NOT mean mail for
      // contact@www.example.com will work. Cloudflare configures subdomain
      // routing separately, with MX records on that exact hostname.
      // GET only. DNS Read may need additional opt-in scope; a 403 denies
      // execution rather than silently creating an unusable forwarding rule.
      return safePage(await cfGet('/zones/' + zoneId +
        '/dns_records?type=MX&name.exact=' + encodeURIComponent(host) +
        '&page=1&per_page=50'));
    },
    async readVerifiedDestination(accountId, email) {
      if (accountId !== owner.cloudflareAccountId ||
          typeof email !== 'string' || email.length > 90 || !MAILBOX.test(email))
        deny('verified_destination_required');
      const values = safePage(await cfGet('/accounts/' + accountId +
        '/email/routing/addresses?page=1&per_page=50'));
      const matches = values.filter(d => lower(d?.email) === lower(email));
      if (matches.length !== 1) deny('verified_destination_required');
      return matches[0];
    },
    async readEmailRoutingRule(zoneId, alias) {
      if (!verifiedZoneIds.has(zoneId) || !MAILBOX.test(alias || ''))
        deny('owned_zone_required');
      // List routing rules with the owner's ACCOUNT ID. The account-level
      // endpoint works with Cloudflare's real API and carries zone tags.
      // A zone ID in /accounts/{id}/... may return 403 even for the owner.
      const rules = safePage(await cfGet('/accounts/' + owner.cloudflareAccountId +
        '/email/routing/rules?page=1&per_page=50'));
      const matches = rules.filter(r =>
        Array.isArray(r?.matchers) &&
        r.matchers.some(m=>m?.type==='literal' && m.field==='to' &&
          lower(m.value)===lower(alias)));
      // Account-level list can contain unrelated tenant zones. The exact
      // alias must not exist in a different/unknown zone, and we must never
      // consider a rule belonging to a different zone an authorized match.
      if (matches.some(r => r?.zone?.tag !== zoneId) || matches.length > 1)
        deny('existing_email_rule_conflict');
      return matches[0] || null;
    },
    async createTurnstileWidget(site, {hostname} = {}) {
      const names = formsTarget(site, hostname);
      const root = accountRoot() + '/challenges/widgets';
      if (exactNamed(safePage(await cfGet(root + '?page=1&per_page=50')), names.widget).length)
        deny('turnstile_widget_exists_reconcile');
      const body = {name: names.widget, domains: [hostname], mode: 'managed'};
      const w = (await cfPost(root, body))?.result;
      if (typeof w?.sitekey !== 'string' || typeof w.secret !== 'string' || w.secret.length < 8 ||
          w.name !== names.widget || w.mode !== 'managed' ||
          JSON.stringify(w.domains) !== JSON.stringify([hostname]))
        deny('turnstile_widget_unverified');
      return {sitekey: w.sitekey, secret: w.secret};
    },
    async readTurnstileSecret(site, {hostname, sitekey} = {}) {
      // Resume after an interrupted run: the secret is re-read, never stored by Launch & Own.
      const names = formsTarget(site, hostname);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(sitekey || '')) deny('turnstile_widget_unverified');
      const w = (await cfGet(accountRoot() + '/challenges/widgets/' + sitekey))?.result;
      if (w?.sitekey !== sitekey || typeof w.secret !== 'string' || w.secret.length < 8 ||
          w.name !== names.widget || w.mode !== 'managed' ||
          JSON.stringify(w.domains) !== JSON.stringify([hostname]))
        deny('turnstile_widget_unverified');
      return {sitekey, secret: w.secret};
    },
    async createCustomerD1(site, {hostname} = {}) {
      const names = formsTarget(site, hostname);
      const root = accountRoot() + '/d1/database';
      if (exactNamed(safePage(await cfGet(root + '?name=' + encodeURIComponent(names.database) +
          '&page=1&per_page=50')), names.database).length)
        deny('customer_d1_exists_reconcile');
      const db = (await cfPost(root, {name: names.database}))?.result;
      if (!/^[a-f0-9-]{36}$/.test(db?.uuid || '') || db.name !== names.database ||
          PLATFORM_D1_IDS.includes(db.uuid))
        deny('customer_d1_unverified');
      return {id: db.uuid, name: names.database};
    },
    async applyCustomerSchema(site, {hostname, databaseId} = {}) {
      formsTarget(site, hostname);
      if (!/^[a-f0-9-]{36}$/.test(databaseId || '') || PLATFORM_D1_IDS.includes(databaseId))
        deny('customer_d1_unverified');
      const out = await cfPost(accountRoot() + '/d1/database/' + databaseId + '/query',
        {sql: CUSTOMER_FORM_SCHEMA_SQL});
      if (!Array.isArray(out?.result) || out.result.some(r => r?.success !== true))
        deny('customer_d1_schema_unverified');
      return {databaseId};
    },
    async deployServerVerifiedFormWorker(site, config = {}) {
      const names = formsTarget(site, config.hostname);
      const upload = await formWorkerUpload(config);
      const scriptPath = accountRoot() + '/workers/scripts/' + names.script;
      // Create only: never replace an existing same-name Worker (its code, schedules or routes).
      // shortcut: GET-then-PUT is not atomic; the single-winner execution lease is the only fence until Cloudflare offers create-if-absent.
      if (await cfGet(scriptPath + '/settings', {allow404: true}) !== null)
        deny('form_worker_exists_reconcile');
      const deployed = (await cfPut(scriptPath, upload.formData,
        {approvalBody: upload.approvalBody}))?.result;
      if (deployed?.id !== names.script || typeof deployed.etag !== 'string' || !deployed.etag)
        deny('form_worker_unverified');
      return {id: names.script, etag: deployed.etag};
    },
    async publishFormWorker(site, {hostname} = {}) {
      const names = formsTarget(site, hostname);
      const scriptPath = accountRoot() + '/workers/scripts/' + names.script;
      await cfPut(scriptPath + '/schedules', [{cron: FORM_WORKER_CRON}]);
      await cfPost(scriptPath + '/subdomain', {enabled: true, previews_enabled: false});
      const sub = (await cfGet(accountRoot() + '/workers/subdomain'))?.result?.subdomain;
      if (!/^[a-z0-9-]{1,63}$/.test(sub || '')) deny('workers_subdomain_required');
      return {endpoint: 'https://' + names.script + '.' + sub + '.workers.dev/submit'};
    },
    async verifyFormAcceptance(site, {hostname, databaseId, gateApprovalId} = {}) {
      // Owner-authorized: reads the actual deployed Worker bindings and the customer's own D1.
      const names = formsTarget(site, hostname);
      if (!/^[a-f0-9-]{36}$/.test(databaseId || '') || PLATFORM_D1_IDS.includes(databaseId))
        deny('customer_d1_unverified');
      const settings = (await cfGet(accountRoot() + '/workers/scripts/' + names.script + '/settings'))?.result;
      const by = Object.fromEntries((settings?.bindings || []).map(x => [x?.name, x]));
      const workerBound = by.DB?.type === 'd1' && (by.DB.id ?? by.DB.database_id) === databaseId &&
        by.SITE_HOSTNAME?.text === hostname && by.GATE_APPROVAL_ID?.text === gateApprovalId &&
        by.TURNSTILE_SECRET?.type === 'secret_text';
      if (!workerBound) return {workerBound: false, accepted: false};
      const rows = (await cfPost(accountRoot() + '/d1/database/' + databaseId + '/query',
        {sql: ACCEPTANCE_SQL, params: [gateApprovalId, hostname]}))?.result?.[0]?.results;
      // A row exists only after a real Siteverify pass, so this is the owner's own test submission.
      return {workerBound, accepted: Number(rows?.[0]?.n) > 0};
    },
    async createEmailRoutingRule(zoneId, rule) {
      if (!verifiedZoneIds.has(zoneId) || !rule ||
          rule.source !== 'api' || rule.enabled !== true ||
          !Array.isArray(rule.matchers) || rule.matchers.length !== 1 ||
          rule.matchers[0]?.type !== 'literal' || rule.matchers[0]?.field !== 'to' ||
          !MAILBOX.test(rule.matchers[0]?.value || '') ||
          !Array.isArray(rule.actions) || rule.actions.length !== 1 ||
          rule.actions[0]?.type !== 'forward' ||
          !Array.isArray(rule.actions[0].value) || rule.actions[0].value.length !== 1 ||
          !MAILBOX.test(rule.actions[0].value[0] || ''))
        deny('unsafe_email_rule');
      const response = await cfPost('/zones/' + zoneId + '/email/routing/rules', rule);
      if (!response?.result?.id || response.result.enabled !== true)
        deny('email_rule_unverified');
      return response.result;
    }
  });
}
