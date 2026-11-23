import test from 'node:test';
import assert from 'node:assert/strict';
import {readPagesAnalyticsStatus} from './pages-analytics.mjs';
import {ProviderRequestError} from './provider-errors.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const site = Object.freeze({githubUserId: 17, cloudflareAccountId: accountId,
  githubOwner: 'test-owner', repositoryId: 451,
  repositoryName: 'esp-willow-studio', pagesProjectName: 'esp-willow-studio-site',
  pagesProjectId: 'immutable-pages-project-id', branch: 'main'});
const principal = Object.freeze({githubUserId: 17, cloudflareAccountId: accountId});
const cloudflareAccessToken = 'secret-cloudflare-token';
const project = () => ({id: site.pagesProjectId, name: site.pagesProjectName,
  subdomain: site.pagesProjectName + '.pages.dev', production_branch: 'main', uses_functions: false,
  source: {type: 'github', config: {owner: site.githubOwner,
    repo_name: site.repositoryName, repo_id: String(site.repositoryId),
    production_deployments_enabled: true}},
  build_config: {build_command: '', root_dir: '', destination_dir: 'public'}});
const json = (body, status = 200) => new Response(JSON.stringify(body),
  {status, headers: {'content-type': 'application/json'}});
function harness(payload = project(), status = 200) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({url, options});
    return json({success: true, result: payload}, status);
  };
  const read = (overrides = {}) => readPagesAnalyticsStatus({site, principal, cloudflareAccessToken,
    fetchFn, ...overrides});
  return {calls, read};
}

test('verified site: only GET, safe dashboard handoff and no invented metrics', async () => {
  const h = harness();
  const result = await h.read();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/' + accountId +
    '/pages/projects/' + site.pagesProjectName);
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.redirect, 'manual');
  assert.equal(h.calls[0].options.headers.authorization, 'Bearer ' + cloudflareAccessToken);
  assert.equal(result.state, 'manual_setup');
  assert.equal(result.configuration, 'not_observed');
  assert.equal(result.metrics.status, 'not_queried');
  assert.equal(result.metrics.visitors, null);
  assert.equal(result.metrics.pageviews, null);
  assert.match(result.action, /next deployment/);
  assert.equal(result.projectDashboardUrl,
    'https://dash.cloudflare.com/' + accountId + '/pages/view/' + site.pagesProjectName);
  // No undocumented global Analytics destination with a literal :account placeholder.
  assert.equal(result.analyticsDashboardUrl, null);
  assert(!JSON.stringify(result).includes(':account'));
  assert(!JSON.stringify(result).includes(cloudflareAccessToken));
});

test('provider analytics tag is not proof of active beacon or actual traffic', async () => {
  const p = project();
  p.web_analytics_tag = 'sensitive-public-tag';
  p.web_analytics_token = 'sensitive-analytics-token';
  p.build_config.web_analytics_token = 'secret-build-token';
  p.canonical_deployment = {id: 'some-deploy', latest_stage: {name: 'deploy', status: 'success'}};
  const result = await harness(p).read();
  assert.equal(result.state, 'manual_setup');
  assert.equal(result.configuration, 'tag_reported_activation_unverified');
  assert.equal(result.metrics.status, 'not_queried');
  const output = JSON.stringify(result);
  for (const secret of ['sensitive-public-tag', 'sensitive-analytics-token', 'secret-build-token'])
    assert(!output.includes(secret));
  assert(!output.includes('active_verified'));
});

test('provider token alone does not establish Web Analytics activation', async () => {
  const p = project(); p.build_config.web_analytics_token = 'x';
  assert.equal((await harness(p).read()).configuration, 'not_observed');
});

test('mismatched account or GitHub owner is denied before provider fetch', async () => {
  const h = harness();
  await assert.rejects(h.read({principal: {...principal, githubUserId: 18}}), /verified, owner-scoped/);
  await assert.rejects(h.read({principal: {...principal, cloudflareAccountId: 'f'.repeat(32)}}), /verified, owner-scoped/);
  await assert.rejects(h.read({site: {...site, githubUserId: 18}}), /verified, owner-scoped/);
  await assert.rejects(h.read({site: {...site, cloudflareAccountId: 'f'.repeat(32)}}), /verified, owner-scoped/);
  assert.equal(h.calls.length, 0);
});

test('rejects untrusted/malformed server inventory identities and path injection', async () => {
  const h = harness();
  const modifications = [
    {repositoryName: '../other'}, {repositoryName: 'unmanaged-repo'},
    {pagesProjectName: 'unrelated'}, {pagesProjectId: ''},
    {branch: 'dev'}, {repositoryId: 0}, {githubUserId: '17'},
    {githubOwner: 'a/b'}, {cloudflareAccountId: '../../evil'}
  ];
  for (const update of modifications)
    await assert.rejects(h.read({site: {...site, ...update}}), /verified, owner-scoped/);
  assert.equal(h.calls.length, 0);
});

test('missing or expired Cloudflare authorization never contacts provider or links account', async () => {
  const h = harness();
  const result = await h.read({cloudflareAccessToken: ''});
  assert.equal(result.state, 'blocked_permission_or_plan');
  assert.equal(result.reason, 'cloudflare_reauthentication_required');
  assert.equal(result.projectDashboardUrl, null);
  assert.equal(h.calls.length, 0);
});

test('401 / 403 yield blocked status without emitting provider secrets or links', async () => {
  for (const status of [401, 403]) {
    const h = harness({}, status);
    const result = await h.read();
    assert.equal(result.state, 'blocked_permission_or_plan');
    assert.equal(result.reason, 'cloudflare_access_denied');
    assert.equal(result.projectDashboardUrl, null);
    assert.equal(result.metrics.pageviews, null);
  }
});

test('rate-limited 403 is retryable, not silently treated as revoked permission', async () => {
  const h = harness();
  await assert.rejects(h.read({fetchFn: async () => new Response('',
    {status: 403, headers: {'retry-after': '5'}})}), error =>
      error instanceof ProviderRequestError && error.retryable && error.retryAfter === 5);
});

test('404 is unavailable, not assumed disabled analytics', async () => {
  const result = await harness({}, 404).read();
  assert.equal(result.state, 'not_available');
  assert.equal(result.reason, 'managed_pages_project_not_accessible');
  assert.equal(result.configuration, 'unknown');
});

test('rate limits, server failures and redirects cannot become successful setup status', async () => {
  for (const status of [302, 429, 500, 503]) {
    const h = harness({}, status);
    await assert.rejects(h.read(), error => error instanceof ProviderRequestError && error.status === status);
  }
});

test('malformed provider success and JSON fail closed', async () => {
  const h = harness();
  await assert.rejects(h.read({fetchFn: async () => json({success: false})}), /verification unavailable/);
  await assert.rejects(h.read({fetchFn: async () => new Response('invalid-json', {status: 200})}),
    /verification unavailable/);
});

test('wrong provider Pages project/repo/tenant/branch/build config is never linked', async () => {
  const modifications = [
    p => {p.id = 'reused-project-name-new-id';},
    p => {p.name = 'different-project';},
    p => {p.subdomain = 'different.pages.dev';},
    p => {p.production_branch = 'preview';},
    p => {p.source.config.owner = 'another-owner';},
    p => {p.source.config.repo_id = '999';},
    p => {p.source.config.repo_name = 'esp-someone-else';},
    p => {p.source.config.production_deployments_enabled = false;},
    p => {p.build_config.destination_dir = 'dist';},
    p => {p.uses_functions = true;},
  ];
  for (const mutate of modifications) {
    const p = project(); mutate(p);
    await assert.rejects(harness(p).read(), /no longer matches/);
  }
});

test('provider fetch network error is not converted into success or invented zeros', async () => {
  const h = harness();
  await assert.rejects(h.read({fetchFn: () => Promise.reject(new TypeError('network unavailable'))}),
    /network unavailable/);
});
