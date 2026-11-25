import test from 'node:test';
import assert from 'node:assert/strict';
import {readPagesAnalyticsStatus} from './pages-analytics.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const site = Object.freeze({
  githubUserId: 17, cloudflareAccountId: accountId,
  githubOwner: 'test-owner', repositoryId: 451,
  repositoryName: 'esp-willow-studio', pagesProjectName: 'esp-willow-studio-site',
  pagesProjectId: 'immutable-pages-project-id', branch: 'main'
});
const principal = Object.freeze({githubUserId: 17, cloudflareAccountId: accountId});
const cloudflareAccessToken = 'secret-cloudflare-token';
const project = () => ({
  id: site.pagesProjectId, name: site.pagesProjectName,
  subdomain: site.pagesProjectName + '.pages.dev',
  production_branch: 'main', uses_functions: false,
  source: {type: 'github', config: {
    owner: site.githubOwner, owner_id: String(site.githubUserId),
    repo_name: site.repositoryName, repo_id: String(site.repositoryId),
    production_deployments_enabled: true
  }},
  build_config: {build_command: '', root_dir: '', destination_dir: 'public'}
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body),
  {status, headers: {'content-type': 'application/json', ...headers}});

function harness(payload = project(), status = 200) {
  const calls = [], authorizations = [];
  const fetchFn = async (url, options) => {
    calls.push({url, options});
    return json({success: true, result: payload}, status);
  };
  const assertCurrentAuthorization = async trusted => {
    authorizations.push(trusted);
    return true;
  };
  const read = (overrides = {}) => readPagesAnalyticsStatus({
    site, principal, cloudflareAccessToken, fetchFn, assertCurrentAuthorization,
    ...overrides
  });
  return {calls, authorizations, read, fetchFn};
}
const assertUnavailable = result => {
  assert.equal(result.action, null);
  assert.equal(result.projectDashboardUrl, null);
  assert.equal(result.analyticsDashboardUrl, null);
  assert.equal(result.configuration, 'unknown');
  assert.equal(result.metrics.status, 'not_queried');
  assert.equal(result.metrics.pageviews, null);
};

test('verified Pages site: GET only, owner ID pinned, and honest settings handoff', async () => {
  const h = harness(), result = await h.read();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/' + accountId +
    '/pages/projects/' + site.pagesProjectName);
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.redirect, 'manual');
  assert.equal(h.calls[0].options.headers.authorization, 'Bearer ' + cloudflareAccessToken);
  assert.equal(h.authorizations.length, 3);
  for (const identity of h.authorizations) {
    assert(Object.isFrozen(identity));
    assert.equal(identity.githubUserId, 17);
    assert.equal(identity.repositoryId, 451);
  }
  assert.equal(result.state, 'manual_setup');
  assert.equal(result.configuration, 'not_observed');
  assert.equal(result.metrics.status, 'not_queried');
  assert.equal(result.metrics.visitors, null);
  assert.equal(result.metrics.pageviews, null);
  assert.match(result.action, /^Review Web Analytics settings/);
  assert.match(result.action, /next deployment/);
  assert.equal(result.projectDashboardUrl,
    'https://dash.cloudflare.com/' + accountId + '/pages/view/' + site.pagesProjectName);
  assert.equal(result.analyticsDashboardUrl, null);
  assert(!JSON.stringify(result).includes(':account'));
  assert(!JSON.stringify(result).includes(cloudflareAccessToken));
});

test('documented build_config tag is configuration, never verified activity or traffic', async () => {
  const p = project();
  p.build_config.web_analytics_tag = 'sensitive-tag';
  p.build_config.web_analytics_token = 'sensitive-token';
  p.canonical_deployment = {latest_stage: {name: 'deploy', status: 'success'}};
  const result = await harness(p).read();
  assert.equal(result.state, 'manual_setup');
  assert.equal(result.configuration, 'tag_reported_activation_unverified');
  assert.equal(result.metrics.status, 'not_queried');
  for (const secret of ['sensitive-tag', 'sensitive-token', cloudflareAccessToken])
    assert(!JSON.stringify(result).includes(secret));
  assert(!JSON.stringify(result).includes('active_verified'));
});

test('undocumented top-level tag and token do not count as Pages configuration', async () => {
  const p = project();
  p.web_analytics_tag = 'top-level-tag';
  p.web_analytics_token = 'private';
  p.build_config.web_analytics_token = 'private-build-token';
  const result = await harness(p).read();
  assert.equal(result.configuration, 'not_observed');
  assert(!JSON.stringify(result).includes('top-level-tag'));
  assert(!JSON.stringify(result).includes('private-build-token'));
});

test('mismatched account or immutable GitHub identity is denied before provider GET', async () => {
  const h = harness();
  await assert.rejects(h.read({principal: {...principal, githubUserId: 18}}), /verified, owner-scoped/);
  await assert.rejects(h.read({principal: {...principal, cloudflareAccountId: 'f'.repeat(32)}}), /verified, owner-scoped/);
  await assert.rejects(h.read({site: {...site, githubUserId: 18}}), /verified, owner-scoped/);
  await assert.rejects(h.read({site: {...site, cloudflareAccountId: 'f'.repeat(32)}}), /verified, owner-scoped/);
  assert.equal(h.calls.length, 0);
});

test('path injection and malformed inventory IDs are refused locally', async () => {
  const h = harness();
  for (const change of [
    {repositoryName: '../other'}, {repositoryName: 'unmanaged-repo'},
    {pagesProjectName: 'unrelated'}, {pagesProjectId: ''},
    {branch: 'dev'}, {repositoryId: 0}, {githubUserId: '17'},
    {githubOwner: 'a/b'}, {cloudflareAccountId: '../../evil'}
  ])
    await assert.rejects(h.read({site: {...site, ...change}}), /verified, owner-scoped/);
  assert.equal(h.calls.length, 0);
});

test('missing live authorization fence denies without contacting Cloudflare', async () => {
  const h = harness();
  const result = await h.read({assertCurrentAuthorization: undefined});
  assert.equal(result.state, 'blocked_permission_or_plan');
  assert.equal(result.reason, 'authorization_fence_required');
  assertUnavailable(result);
  assert.equal(h.calls.length, 0);
});

test('revoked/expired authorization before GET denies without provider read', async () => {
  const h = harness();
  const r1 = await h.read({assertCurrentAuthorization: async () => false});
  const r2 = await h.read({assertCurrentAuthorization: async () => {throw Error('secret-D1-data');}});
  for (const result of [r1, r2]) {
    assert.equal(result.state, 'blocked_permission_or_plan');
    assert.equal(result.reason, 'authorization_changed_or_expired');
    assertUnavailable(result);
    assert(!JSON.stringify(result).includes('secret'));
  }
  assert.equal(h.calls.length, 0);
});

test('revoked access after provider GET suppresses previously verified dashboard link', async () => {
  let checks = 0;
  const h = harness();
  const result = await h.read({assertCurrentAuthorization: async () => ++checks === 1});
  assert.equal(checks, 2);
  assert.equal(h.calls.length, 1);
  assert.equal(result.reason, 'authorization_changed_or_expired');
  assertUnavailable(result);
});

test('revoked access while provider JSON is pending suppresses result', async () => {
  let checks = 0;
  const h = harness();
  const result = await h.read({
    assertCurrentAuthorization: async () => ++checks < 3,
    fetchFn: async () => ({ok: true, status: 200,
      json: async () => ({success: true, result: project()})})
  });
  assert.equal(checks, 3);
  assert.equal(result.reason, 'authorization_changed_or_expired');
  assertUnavailable(result);
});

test('mutation of the original account identity during GET is fenced', async () => {
  const selected = {...principal};
  const h = harness();
  const result = await h.read({principal: selected, fetchFn: async () => {
    selected.cloudflareAccountId = 'f'.repeat(32);
    return json({success: true, result: project()});
  }});
  assert.equal(result.reason, 'authorization_changed_or_expired');
  assertUnavailable(result);
});

test('mutation of trusted site record while JSON awaits is fenced', async () => {
  const siteRecord = {...site};
  const h = harness();
  const result = await h.read({site: siteRecord, fetchFn: async () => ({
    ok: true, status: 200,
    json: async () => {
      siteRecord.repositoryId = 999;
      return {success: true, result: project()};
    }
  })});
  assert.equal(result.reason, 'authorization_changed_or_expired');
  assertUnavailable(result);
});

test('missing provider token denies without GET or dashboard link', async () => {
  const h = harness();
  const result = await h.read({cloudflareAccessToken: ''});
  assert.equal(result.reason, 'cloudflare_reauthentication_required');
  assertUnavailable(result);
  assert.equal(h.calls.length, 0);
});

test('401 requires reauthentication; ordinary 403 means missing project permission', async () => {
  for (const [status, reason] of [
    [401, 'cloudflare_reauthentication_required'], [403, 'cloudflare_permission_denied']
  ]) {
    const result = await harness({}, status).read();
    assert.equal(result.state, 'blocked_permission_or_plan');
    assert.equal(result.reason, reason);
    assertUnavailable(result);
  }
});

test('403 rate limits and 429 are temporary, not revoked consent or verified metrics', async () => {
  const h = harness();
  const r1 = await h.read({fetchFn: async () =>
    json({success: false}, 403, {'retry-after': '5'})});
  const r2 = await h.read({fetchFn: async () => json({}, 429)});
  for (const r of [r1, r2]) {
    assert.equal(r.state, 'not_available');
    assert.equal(r.reason, 'cloudflare_rate_limited');
    assertUnavailable(r);
  }
});

test('404 does not imply Web Analytics itself is unsupported', async () => {
  const result = await harness({}, 404).read();
  assert.equal(result.state, 'not_available');
  assert.equal(result.reason, 'managed_pages_project_not_accessible');
  assertUnavailable(result);
});

test('redirects and server failures return sanitized unavailable status', async () => {
  for (const status of [302, 400, 408, 500, 503]) {
    const result = await harness({}, status).read();
    assert.equal(result.state, 'not_available');
    assert.equal(result.reason, 'cloudflare_temporarily_unavailable');
    assertUnavailable(result);
  }
});

test('network exception containing a token is sanitized and never becomes zero traffic', async () => {
  const h = harness();
  const result = await h.read({fetchFn: async () => {
    throw Error('failed Bearer ' + cloudflareAccessToken);
  }});
  assert.equal(result.state, 'not_available');
  assertUnavailable(result);
  assert(!JSON.stringify(result).includes(cloudflareAccessToken));
});

test('malformed provider JSON and bogus success fail closed with no links', async () => {
  const h = harness();
  for (const fetchFn of [
    async () => json({success: false}),
    async () => new Response('invalid-json', {status: 200}),
    async () => json({success: true, result: null})
  ]) {
    const result = await h.read({fetchFn});
    assert.equal(result.reason, 'cloudflare_unexpected_response');
    assertUnavailable(result);
  }
});

test('wrong Pages project, Git source, ownership and static build configuration are refused', async () => {
  const mutations = [
    p => {p.id = 'replacement-project-id';},
    p => {p.name = 'different-project';},
    p => {p.subdomain = 'other.pages.dev';},
    p => {p.production_branch = 'preview';},
    p => {p.source.config.owner = 'other-owner';},
    p => {p.source.config.owner_id = '18';},
    p => {p.source.config.repo_id = '999';},
    p => {p.source.config.repo_name = 'esp-another-owner';},
    p => {p.source.config.production_deployments_enabled = false;},
    p => {p.build_config.destination_dir = 'dist';},
    p => {p.uses_functions = true;}
  ];
  for (const change of mutations) {
    const p = project(); change(p);
    await assert.rejects(harness(p).read(), /no longer matches/);
  }
});

test('rejects noncanonical GitHub source IDs including leading zero and unsafe integer', async () => {
  for (const [field, invalid] of [
    ['repo_id', '0451'], ['repo_id', '4.51e2'], ['repo_id', '451 '],
    ['repo_id', 451.5], ['repo_id', 9007199254740992],
    ['owner_id', '017'], ['owner_id', 9007199254740992],
    ['owner_id', '-17'], ['owner_id', '17.0']
  ]) {
    const p = project(); p.source.config[field] = invalid;
    await assert.rejects(harness(p).read(), /no longer matches/);
  }
});

test('missing provider owner_id remains compatible but conflicting reported owner_id fails', async () => {
  const p = project(); delete p.source.config.owner_id;
  assert.equal((await harness(p).read()).state, 'manual_setup');
  p.source.config.owner_id = 18;
  await assert.rejects(harness(p).read(), /no longer matches/);
});

test('authorization callback receives only frozen current identity, never credentials', async () => {
  const h = harness();const seen=[];
  await h.read({assertCurrentAuthorization: async value => {
    seen.push(value);
    return Object.isFrozen(value) && !Object.hasOwn(value, 'cloudflareAccessToken');
  }});
  assert.equal(seen.length, 3);
  assert.equal(seen[0], seen[1]);
  assert(!JSON.stringify(seen[0]).includes(cloudflareAccessToken));
});
