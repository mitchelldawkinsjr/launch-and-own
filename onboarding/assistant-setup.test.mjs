import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantScopes, assistantScopesGranted, toolkitAssistantCta
} from './assistant-setup.mjs';
import {
  assistantBootstrapEnabled, createAssistantBootstrapStore
} from './assistant-bootstrap-store.mjs';
import {
  assistantResourceNames, consentMarkup, createAssistantResources
} from './assistant-bootstrap.mjs';
import { ASSISTANT_BOOTSTRAP_WORKER_SOURCE } from './assistant-bootstrap-worker-source.mjs';
import { cloudflareScopes } from './worker.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('assistant scopes never join sign-in; only purpose=assistant when flag on', () => {
  const env = {
    CF_SCOPES: 'account-settings.read page.write',
    CF_ASSISTANT_SCOPES: 'd1.write workers-scripts.admin ai.write bad_scope',
    OPTION_ASSISTANT_BOOTSTRAP_ENABLED: 'true'
  };
  assert.deepEqual(cloudflareScopes(env), ['account-settings.read', 'page.write']);
  assert.deepEqual(cloudflareScopes(env, { assistant: true }),
    ['account-settings.read', 'page.write', 'd1.write', 'workers-scripts.admin', 'ai.write']);
  assert.deepEqual(assistantScopes({ ...env, OPTION_ASSISTANT_BOOTSTRAP_ENABLED: 'false' }), []);
  assert.equal(assistantScopesGranted(env, 'account-settings.read page.write d1.write workers-scripts.admin ai.write'), true);
  assert.equal(assistantScopesGranted(env, 'd1.write'), false);
});

test('toolkit CTA only when flag on and site verified', () => {
  const escape = s => s;
  assert.equal(toolkitAssistantCta({
    jobId: 'job_1', verified: true, env: { OPTION_ASSISTANT_BOOTSTRAP_ENABLED: 'false' }, escape
  }), '');
  assert.equal(toolkitAssistantCta({
    jobId: 'job_1', verified: false, env: { OPTION_ASSISTANT_BOOTSTRAP_ENABLED: 'true' }, escape
  }), '');
  const html = toolkitAssistantCta({
    jobId: '11111111-1111-1111-1111-111111111111', verified: true,
    env: { OPTION_ASSISTANT_BOOTSTRAP_ENABLED: 'true' }, escape
  });
  assert.match(html, /Set up private assistant/);
  assert.match(html, /Owner \/ invite beta/);
  assert.doesNotMatch(html, /available for everyone/i);
});

test('bootstrap store keeps non-secret state only', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of [
    '0001_initial.sql', '0002_token_rotation.sql', '0003_launch_receipts.sql',
    '0004_launch_jobs.sql', '0014_forms_incremental_consent.sql', '0015_assistant_bootstrap.sql'
  ]) {
    sqlite.exec(readFileSync(new URL('./migrations/' + name, import.meta.url), 'utf8'));
  }
  const jobId = '22222222-2222-2222-2222-222222222222';
  const time = Math.floor(Date.now() / 1000);
  sqlite.prepare(
    `INSERT INTO onboarding_launch_jobs
     (id, github_user_id, github_login, cloudflare_account_id, customer_name, site_slug, plan_json,
      approved_html, approval_digest, status, approved_at, updated_at, expires_at, next_attempt_at,
      repository_id, production_branch, expected_commit_sha, pages_project_id, provisioned_at)
     VALUES (?,?,?,?,?,?,?,?,?,'live',?,?,?,?,?,?,?,?,?)`
  ).run(jobId, 1, 'ada', 'a'.repeat(32), 'Ada', 'ada-site', '{}', '<p>x</p>', 'b'.repeat(64),
    time, time, time + 86400, time, 99, 'main', 'c'.repeat(40), 'proj', time);

  const statements = [];
  const env = {
    OPTION_ASSISTANT_BOOTSTRAP_ENABLED: 'true',
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                const row = sqlite.prepare(sql).get(...args);
                return row || null;
              },
              async run() {
                statements.push({ sql, args });
                sqlite.prepare(sql).run(...args);
                return { success: true };
              }
            };
          }
        };
      }
    }
  };
  assert.equal(assistantBootstrapEnabled(env), true);
  const store = createAssistantBootstrapStore(env, {
    github_user_id: 1, cloudflare_account_id: 'a'.repeat(32)
  });
  const started = await store.start({
    jobId, siteSlug: 'ada-site', runId: 'run-1', upstreamSha: 'd'.repeat(40)
  });
  assert.equal(started.step, 'consent');
  const advanced = await store.advance(jobId, {
    step: 'access',
    assistantRepo: 'ada/ada-site-assistant',
    workerName: 'lo-assistant-ada-site',
    d1Id: '11111111-1111-1111-1111-111111111111',
    workerOrigin: 'https://lo-assistant-ada-site.acct.workers.dev',
    createdThisRun: [{ id: 'worker', name: 'lo-assistant-ada-site' }]
  });
  assert.equal(advanced.step, 'access');
  assert.equal(advanced.workerOrigin, 'https://lo-assistant-ada-site.acct.workers.dev');
  const dumped = JSON.stringify(advanced);
  assert.doesNotMatch(dumped, /BEGIN|KEK|private_key|pem/i);
});

test('resource names and consent copy stay honest', () => {
  assert.deepEqual(assistantResourceNames('green-willow'), {
    repo: 'green-willow-assistant',
    worker: 'lo-assistant-green-willow',
    d1: 'lo-assistant-green-willow'
  });
  const html = consentMarkup({
    owner: 'ada', siteSlug: 'green-willow', websiteRepo: 'ada/esp-green-willow'
  });
  assert.match(html, /your<\/strong> accounts/);
  assert.doesNotMatch(html, /free forever/i);
  assert.match(ASSISTANT_BOOTSTRAP_WORKER_SOURCE, /Access not configured/);
  assert.match(ASSISTANT_BOOTSTRAP_WORKER_SOURCE, /healthz/);
});

test('createAssistantResources uploads Worker and never returns KEK', async () => {
  const account = 'a'.repeat(32);
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url === 'https://api.github.com/repos/ada/site-assistant')
      return new Response(null, { status: 404 });
    if (url === 'https://api.github.com/user/repos' && init.method === 'POST')
      return Response.json({ private: true, full_name: 'ada/site-assistant' });
    if (url.includes('/d1/database?name='))
      return Response.json({ success: true, result: [], result_info: { page: 1, total_count: 0, count: 0 } });
    if (url.endsWith('/d1/database') && init.method === 'POST')
      return Response.json({ success: true, result: { uuid: '11111111-1111-1111-1111-111111111111', name: 'lo-assistant-site' } });
    if (url.includes('/d1/database/') && url.endsWith('/query'))
      return Response.json({ success: true, result: [{ success: true }] });
    if (url.endsWith('/workers/subdomain') && (!init.method || init.method === 'GET'))
      return Response.json({ success: true, result: { subdomain: 'acct' } });
    if (url.endsWith('/workers/scripts') && (!init.method || init.method === 'GET'))
      return Response.json({ success: true, result: [] });
    if (url.includes('/workers/scripts/lo-assistant-site') && init.method === 'PUT')
      return Response.json({ success: true, result: { id: 'lo-assistant-site' } });
    if (url.includes('/subdomain') && init.method === 'POST')
      return Response.json({ success: true, result: { enabled: true } });
    if (String(url).endsWith('/healthz'))
      return new Response('ok', { status: 200 });
    return Response.json({ success: true, result: {} });
  };
  const result = await createAssistantResources({
    siteSlug: 'site', ownerLogin: 'ada', websiteRepo: 'ada/esp-site',
    upstreamSha: 'e'.repeat(40), accountId: account,
    cloudflareToken: 'cf', githubToken: 'gh', fetchFn
  });
  assert.equal(result.workerName, 'lo-assistant-site');
  assert.equal(result.workerOrigin, 'https://lo-assistant-site.acct.workers.dev');
  assert.doesNotMatch(JSON.stringify(result), /KEK|BEGIN PRIVATE/i);
  assert.ok(calls.some(c => c.method === 'PUT' && String(c.url).includes('/workers/scripts/')));
});
