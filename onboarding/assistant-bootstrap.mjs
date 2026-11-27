/**
 * Hosted assistant bootstrap engine (no wrangler). Uses the owner's fresh session
 * tokens to create resources in *their* accounts, then discards elevated use.
 * KEK is written only as a Worker secret and never returned or stored in onboarding D1.
 */
import { ASSISTANT_BOOTSTRAP_WORKER_MODULE, ASSISTANT_BOOTSTRAP_WORKER_SOURCE } from './assistant-bootstrap-worker-source.mjs';

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

export function accessGuideMarkup({ siteSlug, origin }) {
  return [
    '<ol>',
    '<li>Open <a href="https://one.dash.cloudflare.com/" rel="noopener">Cloudflare Zero Trust</a> and create an Access application named <strong>Launch &amp; Own Assistant (' + escapeHtml(siteSlug) + ')</strong>.</li>',
    '<li>Application domain: <code>' + escapeHtml(String(origin || '').replace(/^https:\/\//, '')) + '</code></li>',
    '<li>Policy: Allow only your email. Session duration ≤ 24 hours.</li>',
    '<li>Paste the team domain, Application Audience (AUD), and your Access <code>sub</code> below.</li>',
    '</ol>',
    '<p>Until Access is configured, every route except <code>/healthz</code> returns 503.</p>'
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

/** Redeploy shell modules with plain/D1/AI bindings. Existing secrets (KEK, PEM) are retained when omitted. */
async function redeployShell(fetchFn, token, accountRoot, workerName, plainBindings, d1Id) {
  const bindings = [
    { type: 'd1', name: 'DB', id: d1Id },
    { type: 'ai', name: 'AI' },
    ...plainBindings
  ];
  const metadata = { main_module: ASSISTANT_BOOTSTRAP_WORKER_MODULE, bindings };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(ASSISTANT_BOOTSTRAP_WORKER_MODULE,
    new Blob([ASSISTANT_BOOTSTRAP_WORKER_SOURCE], { type: 'application/javascript+module' }),
    ASSISTANT_BOOTSTRAP_WORKER_MODULE);
  const upload = await fetchFn(accountRoot + '/workers/scripts/' + workerName, {
    method: 'PUT', redirect: 'manual',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    body: form
  });
  const uploadBody = await upload.json().catch(() => null);
  if (!upload.ok || uploadBody?.success === false || uploadBody?.result?.id !== workerName)
    throw Error('assistant_worker_unverified');
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

  // 4. Deploy bootstrap Worker with plain vars + KEK secret (secret never returned)
  const scripts = await cfJson(fetchFn, cloudflareToken, 'GET', accountRoot + '/workers/scripts');
  const exists = Array.isArray(scripts?.result) && scripts.result.some(item => item?.id === names.worker);
  if (exists) throw Error('assistant_worker_exists_reconcile');

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

  const subdomain = await cfJson(fetchFn, cloudflareToken, 'POST',
    accountRoot + '/workers/scripts/' + names.worker + '/subdomain',
    { enabled: true, previews_enabled: false });
  if (subdomain?.result?.enabled !== true) throw Error('assistant_worker_address_unverified');

  const health = await fetchFn(origin + '/healthz', { redirect: 'manual' });
  if (health.status !== 200) throw Error('assistant_healthz_failed');

  // kek intentionally dropped — never return or persist it
  return {
    assistantRepo: fullRepo,
    workerName: names.worker,
    d1Id: d1.uuid,
    workerOrigin: origin,
    createdThisRun
  };
}

/** Write Access plain-text bindings via redeploy. Existing secrets (KEK) are retained. */
export async function applyAccessVars({
  accountId, workerName, d1Id, cloudflareToken,
  teamDomain, aud, ownerSub, origin, upstreamSha = '', websiteRepo = 'x/y',
  fetchFn = fetch
} = {}) {
  if (!ACCOUNT.test(accountId || '') || typeof workerName !== 'string' || !workerName ||
      !UUID.test(d1Id || '') || typeof cloudflareToken !== 'string' || !cloudflareToken ||
      !teamDomain || !aud || !ownerSub || !origin)
    throw Error('access_input_invalid');
  const accountRoot = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;
  const [owner, repo] = String(websiteRepo).split('/');
  await redeployShell(fetchFn, cloudflareToken, accountRoot, workerName, [
    { type: 'plain_text', name: 'ASSISTANT_VERSION', text: '0.1.0-bootstrap' },
    { type: 'plain_text', name: 'UPSTREAM_SHA', text: String(upstreamSha).toLowerCase() },
    { type: 'plain_text', name: 'ASSISTANT_ORIGIN', text: String(origin).trim() },
    { type: 'plain_text', name: 'ACCESS_TEAM_DOMAIN', text: String(teamDomain).trim() },
    { type: 'plain_text', name: 'ACCESS_AUD', text: String(aud).trim() },
    { type: 'plain_text', name: 'OWNER_SUB', text: String(ownerSub).trim() },
    { type: 'plain_text', name: 'WEBSITE_OWNER', text: owner || '' },
    { type: 'plain_text', name: 'WEBSITE_REPO', text: repo || '' }
  ], d1Id);
  return { ok: true };
}

/** Store GitHub App installation ids as plain vars + secret. PEM never touches onboarding D1. */
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
  const plain = [
    { type: 'plain_text', name: 'ASSISTANT_VERSION', text: '0.1.0-bootstrap' },
    { type: 'plain_text', name: 'UPSTREAM_SHA', text: String(upstreamSha).toLowerCase() },
    { type: 'plain_text', name: 'ASSISTANT_ORIGIN', text: String(origin || '').trim() },
    { type: 'plain_text', name: 'WEBSITE_OWNER', text: owner || '' },
    { type: 'plain_text', name: 'WEBSITE_REPO', text: repo || '' },
    { type: 'plain_text', name: 'GH_APP_ID', text: String(appId) },
    { type: 'plain_text', name: 'GH_INSTALLATION_ID', text: String(installationId) },
    { type: 'plain_text', name: 'WEBSITE_REPO_ID', text: String(repoId) }
  ];
  if (teamDomain && aud && ownerSub) {
    plain.push(
      { type: 'plain_text', name: 'ACCESS_TEAM_DOMAIN', text: String(teamDomain).trim() },
      { type: 'plain_text', name: 'ACCESS_AUD', text: String(aud).trim() },
      { type: 'plain_text', name: 'OWNER_SUB', text: String(ownerSub).trim() }
    );
  }
  await redeployShell(fetchFn, cloudflareToken, accountRoot, workerName, plain, d1Id);
  await cfJson(fetchFn, cloudflareToken, 'PUT',
    accountRoot + '/workers/scripts/' + workerName + '/secrets',
    { name: 'GH_INSTALLATION_ID', text: String(installationId), type: 'secret_text' });
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
