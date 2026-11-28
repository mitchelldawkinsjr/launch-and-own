/**
 * Hosted assistant bootstrap engine (no wrangler). Uses the owner's fresh session
 * tokens to create resources in *their* accounts, then discards elevated use.
 * KEK is written only as a Worker secret and never returned or stored in onboarding D1.
 */
import { ASSISTANT_BOOTSTRAP_WORKER_MODULE, ASSISTANT_BOOTSTRAP_WORKER_SOURCE } from './assistant-bootstrap-worker-source.mjs';
import { SITE_EDITOR_ASSETS } from './site-editor-assets-source.mjs';
import { ASSETS_BINDING, uploadStaticAssets } from '../assistant/setup/static-assets.mjs';
import {
  ASSISTANT_APP_COMPAT_DATE, ASSISTANT_APP_COMPAT_FLAGS,
  ASSISTANT_APP_WORKER_MODULE, ASSISTANT_APP_WORKER_SOURCE
} from './assistant-app-bundle-source.mjs';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ASSISTANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS onboarding_imported_edit_approvals (
  approval_id TEXT PRIMARY KEY CHECK (length(approval_id) = 32),
  repository_id INTEGER NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (length(base_commit_sha) = 40),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  owner_provider TEXT NOT NULL CHECK (owner_provider IN ('github', 'cloudflare_access')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 80),
  pull_number INTEGER,
  head_sha TEXT NOT NULL DEFAULT '',
  pull_url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (repository_id, base_commit_sha, artifact_digest)
);
CREATE TABLE IF NOT EXISTS assistant_usage (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  neurons INTEGER NOT NULL CHECK (neurons >= 0)
);
`;

export function assistantResourceNames(siteSlug) {
  if (!SLUG.test(siteSlug || '')) throw Error('invalid_site_slug');
  return Object.freeze({
    repo: siteSlug + '-assistant',
    worker: 'lo-assistant-' + siteSlug,
    d1: 'lo-assistant-' + siteSlug
  });
}

export function consentMarkup({ owner, siteSlug, websiteRepo, workersPlan = 'free' }) {
  const names = assistantResourceNames(siteSlug);
  const paid = workersPlan === 'paid'
    ? 'Your account is on Workers Paid. Usage above the included amounts is billed by Cloudflare directly.'
    : 'On the Workers Free plan these fit within free limits. If a daily limit is reached, the assistant stops until the next day (UTC). You are not charged by Launch &amp; Own.';
  return [
    '<p>This creates the following in <strong>your</strong> accounts. Launch &amp; Own does not keep a durable credential for the assistant afterward.</p>',
    '<ul>',
    '<li><strong>GitHub (' + escapeHtml(owner) + ')</strong>: private repository <code>' + escapeHtml(owner + '/' + names.repo) + '</code>; a private GitHub App installed only on <code>' + escapeHtml(websiteRepo) + '</code></li>',
    '<li><strong>Cloudflare</strong>: Worker <code>' + escapeHtml(names.worker) + '</code>, D1 <code>' + escapeHtml(names.d1) + '</code>, Workers AI from your allocation</li>',
    '<li><strong>Access</strong>: you create an Access application that allows only your email (guided next)</li>',
    '</ul>',
    '<p>' + paid + ' Domain registration and other services are separate. Limits can change.</p>',
    '<p>Removing it: delete the GitHub App, Worker, D1 and Access app. Your website stays untouched.</p>'
  ].join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function accessGuideMarkup({ siteSlug, origin, accountId }) {
  const host = escapeHtml(String(origin || '').replace(/^https:\/\//, ''));
  const account = encodeURIComponent(String(accountId || '').trim());
  const settingsUrl = account
    ? 'https://dash.cloudflare.com/' + account + '/one/settings'
    : 'https://one.dash.cloudflare.com/';
  const appsUrl = account
    ? 'https://dash.cloudflare.com/' + account + '/one/access-controls/apps'
    : 'https://one.dash.cloudflare.com/';
  return [
    '<ol>',
    '<li><strong>Team domain:</strong> open <a href="' + settingsUrl + '" rel="noopener">Zero Trust → Settings</a>. Copy the full domain — it looks like <code>your-team.cloudflareaccess.com</code>.</li>',
    '<li>Open <a href="' + appsUrl + '" rel="noopener">Access → Applications</a> → <strong>Create new application</strong> → <strong>Self-hosted and private</strong> → <strong>Workers</strong> (not Private destinations).</li>',
    '<li><strong>Application details:</strong> Destination Worker <code>' + host + '</code> (production and preview URLs). Name: <strong>Launch &amp; Own Assistant (' + escapeHtml(siteSlug) + ')</strong>. Session duration: <strong>24 hours</strong>.</li>',
    '<li><strong>Create new policy:</strong> Action <strong>Allow</strong>. Include → <strong>Emails</strong> → your email only. Save policy, then <strong>Create</strong> the application.</li>',
    '<li><strong>Application AUD:</strong> open that application → <strong>Additional settings</strong> → <strong>Application Audience (AUD) Tag</strong> → copy the Token.</li>',
    '<li><strong>Your Access sub:</strong> open <code>https://&lt;team-domain&gt;/</code> (App Launcher), sign in, then open <code>https://&lt;team-domain&gt;/cdn-cgi/access/get-identity</code>. Copy <code>sub</code> if present; otherwise try <code>id</code>, then <code>user_uuid</code>. After save, if the assistant says Forbidden, it will print the exact <code>sub</code> to paste.</li>',
    '</ol>',
    '<p>The assistant Worker returns 503 until you save Access here. That is expected.</p>'
  ].join('');
}

export function githubAppGuideMarkup({ appSlug, origin }) {
  const name = escapeHtml(appSlug);
  const homepage = origin
    ? '<code>' + escapeHtml(origin) + '</code>'
    : 'your assistant URL (shown above)';
  return [
    '<ol>',
    '<li>Open <a href="https://github.com/settings/apps/new" rel="noopener">GitHub → New GitHub App</a>.</li>',
    '<li><strong>GitHub App name:</strong> <code>' + name + '</code>.</li>',
    '<li><strong>Homepage URL:</strong> ' + homepage + ' (paste the full URL).</li>',
    '<li><strong>Callback / Redirect URI:</strong> leave empty. Skip Identifying and authorizing users — this app uses a private key, not user OAuth.</li>',
    '<li><strong>Webhook:</strong> uncheck <strong>Active</strong>. Leave Webhook URL and Secret empty.</li>',
    '<li><strong>Repository permissions:</strong> Contents → Read and write; Pull requests → Read and write; Metadata → Read-only. Leave other permissions and event subscriptions alone.</li>',
    '<li><strong>Where can this GitHub App be installed?</strong> → Only on this account. Then Create GitHub App.</li>',
    '<li>On the app’s <strong>General</strong> page, copy the <strong>App ID</strong>. Under Private keys → <strong>Generate a private key</strong>, open the downloaded <code>.pem</code>, and paste the full file below (including BEGIN/END lines).</li>',
    '</ol>',
    '<p>These credentials go into <strong>your</strong> Worker secrets only — never into Launch &amp; Own storage.</p>'
  ].join('');
}

export function installGuideMarkup({ appSlug, websiteRepo }) {
  return [
    '<ol>',
    '<li>Open <a href="https://github.com/apps/' + encodeURIComponent(appSlug) + '/installations/new" rel="noopener">Install ' + escapeHtml(appSlug) + '</a>.</li>',
    '<li>Choose <strong>Only select repositories</strong> → <code>' + escapeHtml(websiteRepo) + '</code> (never the assistant repo).</li>',
    '<li>Paste the installation id and the website repository numeric id below.</li>',
    '</ol>'
  ].join('');
}

async function cfJson(fetchFn, token, method, url, body) {
  const init = {
    method, redirect: 'manual',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' }
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetchFn(url, init);
  if (method === 'DELETE' && (response.status === 200 || response.status === 404))
    return { success: true };
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false)
    throw Object.assign(Error('cloudflare_api_' + response.status), { status: response.status, data });
  return data;
}

async function existingBindings(fetchFn, token, accountRoot, workerName) {
  try {
    const data = await cfJson(fetchFn, token, 'GET',
      accountRoot + '/workers/scripts/' + workerName + '/settings');
    return Array.isArray(data?.result?.bindings) ? data.result.bindings : [];
  } catch {
    return [];
  }
}

/** Redeploy Worker modules with plain/D1/AI bindings. keep_bindings retains KEK / PEM secrets. */
async function redeployShell(fetchFn, token, accountRoot, workerName, plainBindings, d1Id, {
  moduleName = ASSISTANT_BOOTSTRAP_WORKER_MODULE,
  source = ASSISTANT_BOOTSTRAP_WORKER_SOURCE,
  compatibilityDate = '2026-11-21',
  compatibilityFlags = [],
  assetsJwt = null
} = {}) {
  const bindings = [
    { type: 'd1', name: 'DB', id: d1Id },
    { type: 'ai', name: 'AI' },
    ...(assetsJwt ? [{ ...ASSETS_BINDING }] : []),
    ...plainBindings
  ];
  const metadata = {
    main_module: moduleName,
    bindings,
    // Same as assistant/wrangler.example.jsonc: the Worker (Access + owner check) runs before any asset.
    ...(assetsJwt ? { assets: { jwt: assetsJwt, config: { run_worker_first: true, html_handling: 'none', not_found_handling: 'none' } } } : {}),
    keep_bindings: ['secret_text'],
    compatibility_date: compatibilityDate,
    ...(compatibilityFlags.length ? { compatibility_flags: compatibilityFlags } : {})
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(moduleName,
    new Blob([source], { type: 'application/javascript+module' }),
    moduleName);
  const upload = await fetchFn(accountRoot + '/workers/scripts/' + workerName, {
    method: 'PUT', redirect: 'manual',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    body: form
  });
  const uploadBody = await upload.json().catch(() => null);
  const resultId = uploadBody?.result?.id || uploadBody?.result?.script;
  if (!upload.ok || uploadBody?.success === false || resultId !== workerName) {
    const detail = Array.isArray(uploadBody?.errors) && uploadBody.errors[0]?.message
      ? String(uploadBody.errors[0].message).slice(0, 80)
      : ('status_' + upload.status);
    throw Error('assistant_worker_unverified:' + detail);
  }
  return uploadBody.result;
}

async function ghJson(fetchFn, token, method, url, body) {
  const init = {
    method, redirect: 'manual',
    headers: {
      authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own'
    }
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetchFn(url, init);
  if (response.status === 404) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(Error('github_api_' + response.status), { status: response.status, data });
  return data;
}

/** Create private assistant repo + D1 + Worker + KEK. Returns non-secret IDs only. */
export async function createAssistantResources({
  siteSlug, ownerLogin, websiteRepo, upstreamSha, accountId,
  cloudflareToken, githubToken, fetchFn = fetch
} = {}) {
  if (!SLUG.test(siteSlug) || !ACCOUNT.test(accountId || '') ||
      typeof cloudflareToken !== 'string' || !cloudflareToken ||
      typeof githubToken !== 'string' || !githubToken ||
      !/^[\w.-]+\/[\w.-]+$/.test(websiteRepo || ''))
    throw Error('bootstrap_input_invalid');

  const names = assistantResourceNames(siteSlug);
  const createdThisRun = [];
  const accountRoot = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;

  // 1. Private assistant repo (empty private; customer owns it; template contents come via updates).
  const fullRepo = ownerLogin + '/' + names.repo;
  let repo = await ghJson(fetchFn, githubToken, 'GET', 'https://api.github.com/repos/' + fullRepo);
  if (!repo) {
    repo = await ghJson(fetchFn, githubToken, 'POST', 'https://api.github.com/user/repos', {
      name: names.repo, private: true, description: 'Launch & Own private website assistant',
      auto_init: true, has_issues: false, has_projects: false, has_wiki: false
    });
    createdThisRun.push({ id: 'assistant-repo', name: fullRepo });
  }
  if (!repo?.private || repo.full_name?.toLowerCase() !== fullRepo.toLowerCase())
    throw Error('assistant_repo_unverified');

  // 2. D1
  const list = await cfJson(fetchFn, cloudflareToken, 'GET',
    accountRoot + '/d1/database?name=' + encodeURIComponent(names.d1) + '&page=1&per_page=50');
  let d1 = Array.isArray(list?.result) ? list.result.find(db => db?.name === names.d1) : null;
  if (!d1) {
    const created = await cfJson(fetchFn, cloudflareToken, 'POST', accountRoot + '/d1/database', { name: names.d1 });
    d1 = created?.result;
    createdThisRun.push({ id: 'd1', name: names.d1, databaseId: d1?.uuid });
  }
  if (!UUID.test(d1?.uuid || '') || d1.name !== names.d1) throw Error('assistant_d1_unverified');
  await cfJson(fetchFn, cloudflareToken, 'POST', accountRoot + '/d1/database/' + d1.uuid + '/query',
    { sql: ASSISTANT_SCHEMA_SQL });

  // 3. Workers subdomain (needed for workers.dev origin during bootstrap)
  const sub = (await cfJson(fetchFn, cloudflareToken, 'GET', accountRoot + '/workers/subdomain'))?.result?.subdomain;
  if (typeof sub !== 'string' || !sub) throw Error('workers_subdomain_required');
  const origin = 'https://' + names.worker + '.' + sub + '.workers.dev';

  // 4. Deploy bootstrap Worker + KEK, or reuse one left from a prior attempt (idempotent).
  const scripts = await cfJson(fetchFn, cloudflareToken, 'GET', accountRoot + '/workers/scripts');
  const exists = Array.isArray(scripts?.result) && scripts.result.some(item => item?.id === names.worker);
  if (!exists) {
    const kekBytes = new Uint8Array(32);
    crypto.getRandomValues(kekBytes);
    const kek = [...kekBytes].map(b => b.toString(16).padStart(2, '0')).join('');
    const metadata = {
      main_module: ASSISTANT_BOOTSTRAP_WORKER_MODULE,
      bindings: [
        { type: 'd1', name: 'DB', id: d1.uuid },
        { type: 'ai', name: 'AI' },
        { type: 'plain_text', name: 'ASSISTANT_VERSION', text: '0.1.0-bootstrap' },
        { type: 'plain_text', name: 'UPSTREAM_SHA', text: String(upstreamSha || '').toLowerCase() },
        { type: 'plain_text', name: 'ASSISTANT_ORIGIN', text: origin },
        { type: 'plain_text', name: 'WEBSITE_OWNER', text: websiteRepo.split('/')[0] },
        { type: 'plain_text', name: 'WEBSITE_REPO', text: websiteRepo.split('/')[1] },
        { type: 'secret_text', name: 'KEK', text: kek }
      ]
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.set(ASSISTANT_BOOTSTRAP_WORKER_MODULE,
      new Blob([ASSISTANT_BOOTSTRAP_WORKER_SOURCE], { type: 'application/javascript+module' }),
      ASSISTANT_BOOTSTRAP_WORKER_MODULE);
    const upload = await fetchFn(accountRoot + '/workers/scripts/' + names.worker, {
      method: 'PUT', redirect: 'manual',
      headers: { authorization: 'Bearer ' + cloudflareToken, accept: 'application/json' },
      body: form
    });
    const uploadBody = await upload.json().catch(() => null);
    if (!upload.ok || uploadBody?.success === false || uploadBody?.result?.id !== names.worker)
      throw Error('assistant_worker_unverified');
    createdThisRun.push({ id: 'worker', name: names.worker });
    // kek intentionally dropped — never return or persist it
  }

  const subdomain = await cfJson(fetchFn, cloudflareToken, 'POST',
    accountRoot + '/workers/scripts/' + names.worker + '/subdomain',
    { enabled: true, previews_enabled: false });
  if (subdomain?.result?.enabled !== true) throw Error('assistant_worker_address_unverified');

  const health = await fetchFn(origin + '/healthz', { redirect: 'manual' });
  if (health.status !== 200) throw Error('assistant_healthz_failed');

  return {
    assistantRepo: fullRepo,
    workerName: names.worker,
    d1Id: d1.uuid,
    workerOrigin: origin,
    createdThisRun
  };
}

function normalizeTeamDomain(value) {
  return String(value || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function ensureKekSecret(fetchFn, token, accountRoot, workerName) {
  const listed = await cfJson(fetchFn, token, 'GET',
    accountRoot + '/workers/scripts/' + workerName + '/secrets').catch(() => null);
  const names = Array.isArray(listed?.result)
    ? listed.result.map(s => s?.name).filter(Boolean)
    : [];
  if (names.includes('KEK')) return;
  const kekBytes = new Uint8Array(32);
  crypto.getRandomValues(kekBytes);
  const kek = [...kekBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  await cfJson(fetchFn, token, 'PUT', accountRoot + '/workers/scripts/' + workerName + '/secrets',
    { name: 'KEK', text: kek, type: 'secret_text' });
}

async function assertAccessBindings(fetchFn, token, accountRoot, workerName, expected) {
  const bindings = await existingBindings(fetchFn, token, accountRoot, workerName);
  const plain = Object.fromEntries(bindings
    .filter(b => b?.type === 'plain_text' && typeof b.name === 'string')
    .map(b => [b.name, String(b.text || '').trim()]));
  const secrets = new Set(bindings.filter(b => b?.type === 'secret_text').map(b => b.name));
  for (const [name, value] of Object.entries(expected)) {
    if (plain[name] !== value) throw Error('access_binding_missing:' + name);
  }
  if (!secrets.has('KEK')) throw Error('access_binding_missing:KEK');
}

/** Write Access plain-text bindings via redeploy. Keeps secrets; restores KEK if missing. */
export async function applyAccessVars({
  accountId, workerName, d1Id, cloudflareToken,
  teamDomain, aud, ownerSub, origin, upstreamSha = '', websiteRepo = 'x/y',
  fetchFn = fetch
} = {}) {
  const domain = normalizeTeamDomain(teamDomain);
  const audience = String(aud || '').trim();
  const sub = String(ownerSub || '').trim();
  const assistantOrigin = String(origin || '').trim().replace(/\/+$/, '');
  if (!ACCOUNT.test(accountId || '') || typeof workerName !== 'string' || !workerName ||
      !UUID.test(d1Id || '') || typeof cloudflareToken !== 'string' || !cloudflareToken ||
      !domain || !audience || !sub || !assistantOrigin)
    throw Error('access_input_invalid');
  const accountRoot = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;
  const [owner, repo] = String(websiteRepo).split('/');
  const prior = (await existingBindings(fetchFn, cloudflareToken, accountRoot, workerName))
    .filter(b => b?.type === 'plain_text' && typeof b.name === 'string' && typeof b.text === 'string');
  const priorByName = Object.fromEntries(prior.map(b => [b.name, b.text]));
  const plain = [
    { type: 'plain_text', name: 'ASSISTANT_VERSION', text: '0.1.0-bootstrap' },
    { type: 'plain_text', name: 'UPSTREAM_SHA', text: String(upstreamSha || priorByName.UPSTREAM_SHA || '').toLowerCase() },
    { type: 'plain_text', name: 'ASSISTANT_ORIGIN', text: assistantOrigin },
    { type: 'plain_text', name: 'ACCESS_TEAM_DOMAIN', text: domain },
    { type: 'plain_text', name: 'ACCESS_AUD', text: audience },
    { type: 'plain_text', name: 'OWNER_SUB', text: sub },
    { type: 'plain_text', name: 'WEBSITE_OWNER', text: owner || priorByName.WEBSITE_OWNER || '' },
    { type: 'plain_text', name: 'WEBSITE_REPO', text: repo || priorByName.WEBSITE_REPO || '' }
  ];
  for (const name of ['GH_APP_ID', 'GH_INSTALLATION_ID', 'WEBSITE_REPO_ID']) {
    if (priorByName[name]) plain.push({ type: 'plain_text', name, text: priorByName[name] });
  }
  await redeployShell(fetchFn, cloudflareToken, accountRoot, workerName, plain, d1Id);
  await ensureKekSecret(fetchFn, cloudflareToken, accountRoot, workerName);
  await assertAccessBindings(fetchFn, cloudflareToken, accountRoot, workerName, {
    ACCESS_TEAM_DOMAIN: domain,
    ACCESS_AUD: audience,
    OWNER_SUB: sub,
    ASSISTANT_ORIGIN: assistantOrigin
  });
  return { ok: true };
}

/** Store GitHub App installation ids as plain vars. PEM stays a Worker secret (never onboarding D1). */
export async function applyGithubInstall({
  accountId, workerName, d1Id, cloudflareToken,
  installationId, repoId, appId, origin, upstreamSha = '', websiteRepo = 'x/y',
  teamDomain = '', aud = '', ownerSub = '', fetchFn = fetch
} = {}) {
  if (!ACCOUNT.test(accountId || '') || !UUID.test(d1Id || '') ||
      !/^\d+$/.test(String(installationId || '')) ||
      !/^\d+$/.test(String(repoId || '')) || !/^\d+$/.test(String(appId || '')))
    throw Error('github_install_input_invalid');

  const accountRoot = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;
  const [owner, repo] = String(websiteRepo).split('/');
  const prior = (await existingBindings(fetchFn, cloudflareToken, accountRoot, workerName))
    .filter(b => b?.type === 'plain_text' && typeof b.name === 'string' && typeof b.text === 'string');
  const priorByName = Object.fromEntries(prior.map(b => [b.name, b.text]));
  const accessTeam = String(teamDomain || priorByName.ACCESS_TEAM_DOMAIN || '').trim();
  const accessAud = String(aud || priorByName.ACCESS_AUD || '').trim();
  const accessSub = String(ownerSub || priorByName.OWNER_SUB || '').trim();
  const plain = [
    { type: 'plain_text', name: 'ASSISTANT_VERSION', text: '0.1.0-bootstrap' },
    { type: 'plain_text', name: 'UPSTREAM_SHA', text: String(upstreamSha).toLowerCase() },
    { type: 'plain_text', name: 'ASSISTANT_ORIGIN',
      text: String(origin || priorByName.ASSISTANT_ORIGIN || '').trim() },
    { type: 'plain_text', name: 'WEBSITE_OWNER', text: owner || '' },
    { type: 'plain_text', name: 'WEBSITE_REPO', text: repo || '' },
    { type: 'plain_text', name: 'GH_APP_ID', text: String(appId) },
    { type: 'plain_text', name: 'GH_INSTALLATION_ID', text: String(installationId) },
    { type: 'plain_text', name: 'WEBSITE_REPO_ID', text: String(repoId) }
  ];
  if (accessTeam && accessAud && accessSub) {
    plain.push(
      { type: 'plain_text', name: 'ACCESS_TEAM_DOMAIN', text: accessTeam },
      { type: 'plain_text', name: 'ACCESS_AUD', text: accessAud },
      { type: 'plain_text', name: 'OWNER_SUB', text: accessSub }
    );
  }
  await redeployShell(fetchFn, cloudflareToken, accountRoot, workerName, plain, d1Id);
  return { ok: true };
}

export async function putGithubAppPrivateKey({
  accountId, workerName, cloudflareToken, privateKeyPem, fetchFn = fetch
} = {}) {
  if (!ACCOUNT.test(accountId || '') || typeof privateKeyPem !== 'string' ||
      !privateKeyPem.includes('BEGIN') || privateKeyPem.length < 64)
    throw Error('github_key_invalid');
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + accountId +
    '/workers/scripts/' + workerName + '/secrets';
  await cfJson(fetchFn, cloudflareToken, 'PUT', url, {
    name: 'GH_APP_PRIVATE_KEY', text: privateKeyPem, type: 'secret_text'
  });
  return { ok: true };
}

/**
 * Replace the bootstrap shell with the full assistant app (editor + AI_EDITS).
 * Keeps Access / GitHub secrets; turns on plain-language edits; uploads the vendored site editor as
 * Workers Static Assets (ASSETS binding) so the visual canvas matches the hosted toolkit (ADR-005).
 */
export async function upgradeAssistantApp({
  accountId, workerName, d1Id, cloudflareToken,
  origin, upstreamSha = '', websiteRepo = 'x/y', fetchFn = fetch
} = {}) {
  if (!ACCOUNT.test(accountId || '') || typeof workerName !== 'string' || !workerName ||
      !UUID.test(d1Id || '') || typeof cloudflareToken !== 'string' || !cloudflareToken ||
      !origin)
    throw Error('assistant_upgrade_input_invalid');
  if (typeof ASSISTANT_APP_WORKER_SOURCE !== 'string' || ASSISTANT_APP_WORKER_SOURCE.length < 10_000)
    throw Error('assistant_app_bundle_missing');

  const accountRoot = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;
  const [owner, repo] = String(websiteRepo).split('/');
  const prior = (await existingBindings(fetchFn, cloudflareToken, accountRoot, workerName))
    .filter(b => b?.type === 'plain_text' && typeof b.name === 'string' && typeof b.text === 'string');
  const priorByName = Object.fromEntries(prior.map(b => [b.name, b.text]));
  const required = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OWNER_SUB'];
  for (const name of required) {
    if (!priorByName[name]) throw Error('access_binding_missing:' + name);
  }
  const plain = [
    { type: 'plain_text', name: 'ASSISTANT_VERSION', text: '0.1.0-app' },
    { type: 'plain_text', name: 'UPSTREAM_SHA',
      text: String(upstreamSha || priorByName.UPSTREAM_SHA || '').toLowerCase() },
    { type: 'plain_text', name: 'ASSISTANT_ORIGIN',
      text: String(origin || priorByName.ASSISTANT_ORIGIN || '').trim().replace(/\/+$/, '') },
    { type: 'plain_text', name: 'ACCESS_TEAM_DOMAIN', text: priorByName.ACCESS_TEAM_DOMAIN },
    { type: 'plain_text', name: 'ACCESS_AUD', text: priorByName.ACCESS_AUD },
    { type: 'plain_text', name: 'OWNER_SUB', text: priorByName.OWNER_SUB },
    { type: 'plain_text', name: 'WEBSITE_OWNER', text: owner || priorByName.WEBSITE_OWNER || '' },
    { type: 'plain_text', name: 'WEBSITE_REPO', text: repo || priorByName.WEBSITE_REPO || '' },
    { type: 'plain_text', name: 'AI_EDITS', text: 'on' },
    { type: 'plain_text', name: 'AI_MODEL', text: '@cf/openai/gpt-oss-120b' },
    { type: 'plain_text', name: 'DAILY_NEURON_BUDGET', text: '8000' }
  ];
  for (const name of ['GH_APP_ID', 'GH_INSTALLATION_ID', 'WEBSITE_REPO_ID']) {
    if (priorByName[name]) plain.push({ type: 'plain_text', name, text: priorByName[name] });
  }
  const assetsJwt = await uploadStaticAssets({ accountId, workerName, cloudflareToken, files: SITE_EDITOR_ASSETS, fetchFn });
  await redeployShell(fetchFn, cloudflareToken, accountRoot, workerName, plain, d1Id, {
    assetsJwt,
    moduleName: ASSISTANT_APP_WORKER_MODULE,
    source: ASSISTANT_APP_WORKER_SOURCE,
    compatibilityDate: ASSISTANT_APP_COMPAT_DATE,
    compatibilityFlags: [...ASSISTANT_APP_COMPAT_FLAGS]
  });
  await ensureKekSecret(fetchFn, cloudflareToken, accountRoot, workerName);
  return { ok: true, version: '0.1.0-app' };
}

export async function rollbackCreated({
  accountId, cloudflareToken, githubToken, createdThisRun = [], fetchFn = fetch
} = {}) {
  const report = [];
  for (const item of [...createdThisRun].reverse()) {
    try {
      if (item.id === 'worker') {
        await cfJson(fetchFn, cloudflareToken, 'DELETE',
          'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/workers/scripts/' + item.name);
        report.push('deleted worker ' + item.name);
      } else if (item.id === 'd1') {
        await cfJson(fetchFn, cloudflareToken, 'DELETE',
          'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/d1/database/' + item.databaseId);
        report.push('deleted d1 ' + item.name);
      } else if (item.id === 'assistant-repo' && githubToken) {
        await ghJson(fetchFn, githubToken, 'DELETE', 'https://api.github.com/repos/' + item.name);
        report.push('deleted repo ' + item.name);
      }
    } catch {
      report.push('rollback_failed:' + item.id);
    }
  }
  return report;
}
