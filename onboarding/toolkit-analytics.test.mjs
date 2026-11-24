import test from 'node:test';
import assert from 'node:assert/strict';
import {loadToolkitAnalytics, renderToolkitAnalytics} from './toolkit-analytics.mjs';

const account = 'a1'.repeat(16);
const site = Object.freeze({
  githubUserId: 17,
  githubOwner: 'test-owner',
  repositoryId: 451,
  repositoryName: 'esp-willow-studio',
  cloudflareAccountId: account,
  pagesProjectId: 'private-project-immutable-id',
  pagesProjectName: 'esp-willow-studio-site',
  branch: 'main'
});
const principal = {githubUserId: site.githubUserId, cloudflareAccountId: account};
const token = 'test-cloudflare-access-token';
const dashboard = 'https://dash.cloudflare.com/' + account + '/pages/view/' + site.pagesProjectName;
const escape = value => String(value);

function project({
  id = site.pagesProjectId,
  analytics = {}
} = {}) {
  return {
    id,
    name: site.pagesProjectName,
    production_branch: 'main',
    subdomain: site.pagesProjectName + '.pages.dev',
    source: {type: 'github', config: {
      owner: site.githubOwner,
      owner_id: String(site.githubUserId),
      repo_id: String(site.repositoryId),
      repo_name: site.repositoryName
    }},
    build_config: {destination_dir: 'public', ...analytics}
  };
}

function options(fetchFn, overrides = {}) {
  return {
    site,
    principal,
    cloudflareAccessToken: token,
    assertCurrentAuthorization: async () => true,
    fetchFn,
    ...overrides
  };
}

test('verified analytics settings give one credential-free Pages dashboard link', async () => {
  const calls = [];
  const result = await loadToolkitAnalytics(options(async (url, request) => {
    calls.push({url, method: request.method, redirect: request.redirect});
    return Response.json({success: true, result: project()});
  }));
  assert.deepEqual(calls, [{
    url: 'https://api.cloudflare.com/client/v4/accounts/' + account + '/pages/projects/' + site.pagesProjectName,
    method: 'GET',
    redirect: 'manual'
  }]);
  assert.equal(result.configuration, 'not_observed');
  assert.equal(result.projectDashboardUrl, dashboard);

  const html = renderToolkitAnalytics(result, {escape});
  assert.ok(html.includes('href="' + dashboard + '" rel="noreferrer"'));
  assert.match(html, /Metrics → Web Analytics/);
  assert.match(html, /privacy notice before opting in/);
  assert.match(html, /next deployment/);
  assert.match(html, /approve that deployment separately/);
  assert.doesNotMatch(html, /<form|<iframe|<script|<img/);
  assert.ok(!html.includes(site.pagesProjectId));
  assert.ok(!html.includes(token));
});

test('tag evidence never renders analytics activity, metrics, or credentials', async () => {
  const secrets = ['provider-tag', 'provider-token', token, site.pagesProjectId];
  const result = await loadToolkitAnalytics(options(async () => Response.json({
    success: true, result: project({analytics: {
      web_analytics_tag: secrets[0], web_analytics_token: secrets[1]
    }})
  })));

  const serialized = JSON.stringify(result);
  const html = renderToolkitAnalytics(result, {escape});
  assert.equal(result.configuration, 'tag_reported_activation_unverified');
  assert.match(html, /live beacon and traffic still need verification/);
  assert.match(html, /Traffic data is unavailable/);
  assert.doesNotMatch(html, /\bactive\b|<table|0 visits/i);
  for (const secret of secrets) {
    assert.ok(!serialized.includes(secret));
    assert.ok(!html.includes(secret));
  }
});

test('account mismatch, project replacement, and revoked sessions suppress handoff', async () => {
  const validResponse = () => Response.json({success: true, result: project()});
  let sessionCurrent = true;
  let mismatchedAccountReads = 0;
  const requests = [
    options(async () => {
      mismatchedAccountReads += 1;
      return validResponse();
    }, {principal: {...principal, cloudflareAccountId: 'f'.repeat(32)}}),
    options(async () => Response.json({success: true, result: project({id: 'replacement'})})),
    options(async () => {
      sessionCurrent = false;
      return validResponse();
    }, {assertCurrentAuthorization: async () => sessionCurrent})
  ];

  for (const request of requests) {
    const result = await loadToolkitAnalytics(request);
    assert.equal(result.projectDashboardUrl, null);
    assert.doesNotMatch(renderToolkitAnalytics(result, {escape}), /href=|private-project-immutable-id/);
  }
  assert.equal(mismatchedAccountReads, 0);
});

test('expired and missing read permission have distinct safe copy', async () => {
  for (const [httpStatus, message] of [
    [401, /Sign in to Cloudflare again/],
    [403, /needs permission to read this Pages project/],
    [429, /request limit/]
  ]) {
    const result = await loadToolkitAnalytics(options(async () => new Response(null, {status: httpStatus})));
    const html = renderToolkitAnalytics(result, {escape});
    assert.match(html, message);
    assert.doesNotMatch(html, /href=/);
  }
});

test('rendering refuses unrecognized dashboard addresses and states', () => {
  const display = (url, state = 'manual_setup') => renderToolkitAnalytics({
    state, configuration: 'not_observed', projectDashboardUrl: url
  }, {escape});
  for (const url of [
    'https://dash.cloudflare.com.evil.invalid/' + account + '/pages/view/esp-willow-studio-site',
    dashboard + '?redirect=evil',
    dashboard + '" onclick="alert(1)',
    'javascript:alert(1)'
  ]) {
    assert.doesNotMatch(display(url), /href=|onclick=/);
  }
  assert.doesNotMatch(display(dashboard, 'active_verified'), /href=/);
});
