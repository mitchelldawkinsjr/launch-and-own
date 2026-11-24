import assert from 'node:assert/strict';
import test from 'node:test';
import {UPDATE_BRANCH_PATTERN} from '../pipeline/pages-preview-policy.mjs';
import {readToolkitPreviewStatus, renderToolkitPreviewStatus} from './toolkit-preview.mjs';

const account = 'a'.repeat(32);
const site = Object.freeze({
  githubUserId: 7, githubOwner: 'customer', cloudflareAccountId: account, repositoryId: 42,
  repositoryName: 'esp-example', pagesProjectId: 'project-123', pagesProjectName: 'esp-example-site',
  branch: 'main'
});
const principal = Object.freeze({githubUserId: 7, githubLogin: 'Customer', cloudflareAccountId: account});
const scoped = {
  preview_deployment_setting: 'custom', preview_branch_includes: [UPDATE_BRANCH_PATTERN],
  preview_branch_excludes: ['main'], pr_comments_enabled: false
};

function project(settings) {
  return {
    id: site.pagesProjectId, name: site.pagesProjectName,
    subdomain: site.pagesProjectName + '.pages.dev', production_branch: 'main',
    source: {type: 'github', config: {
      owner: site.githubOwner, owner_id: '7', repo_name: site.repositoryName, repo_id: '42',
      production_deployments_enabled: true, ...settings
    }},
    build_config: {build_command: '', root_dir: '', destination_dir: 'public'}
  };
}

const pagesResponse = result => Response.json({success: true, result});
function input(fetchFn, overrides) {
  return {
    site, principal, cloudflareAccessToken: 'fixture-owner-token',
    assertCurrentAuthorization: async () => true,
    fetchFn, ...overrides
  };
}

test('an exact owned project reported off gives a safe disabled panel', async () => {
  let reads = 0;
  let fences = 0;
  const result = await readToolkitPreviewStatus(input(async (url, options) => {
    ++reads;
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/' + account +
      '/pages/projects/' + site.pagesProjectName);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer fixture-owner-token');
    return pagesResponse({
      ...project({preview_deployment_setting: 'none'}),
      aliases: ['https://retained-preview.example.invalid/']
    });
  }, {
    assertCurrentAuthorization: async identity => {
      ++fences;
      assert.equal(Object.isFrozen(identity), true);
      assert.deepEqual(identity, {...site, githubLogin: principal.githubLogin});
      return true;
    }
  }));
  assert.equal(reads, 1);
  assert.equal(fences, 3);
  assert.deepEqual(result, {state: 'disabled'});
  const html = renderToolkitPreviewStatus(result);
  assert.match(html, /New preview builds are off/);
  assert.match(html, /Previously built previews can still be reachable/);
  assert.match(html, /public by default/);
  assert.doesNotMatch(html, /href=|retained-preview|fixture-owner-token/);
});

test('scoped settings describe configuration while broader settings need review', async () => {
  const cases = [
    [scoped, 'configured-unverified', /Access protection and the exact pull request revision still need verification/],
    [{preview_deployment_setting: 'all'}, 'unsafe-configuration', /Preview branch settings need review/],
    [{...scoped, pr_comments_enabled: true}, 'unsafe-configuration', /Preview branch settings need review/],
    [{}, 'unknown-configuration', /Preview settings are unknown/]
  ];
  for (const [settings, state, copy] of cases) {
    const result = await readToolkitPreviewStatus(input(async () => pagesResponse({
      ...project(settings), accessVerified: true, previewUrl: 'https://preview.example.invalid/'
    })));
    assert.deepEqual(result, {state});
    const html = renderToolkitPreviewStatus(result);
    assert.match(html, copy);
    assert.doesNotMatch(html, /href=|preview\.example\.invalid/);
  }
});

test('unowned references and expired grants stop before reaching Cloudflare', async () => {
  let gets = 0;
  const fetchFn = async () => { ++gets; return pagesResponse(project(scoped)); };
  const cases = [
    [{principal: {...principal, githubUserId: 8}}, 'unavailable'],
    [{principal: {...principal, githubLogin: 'other'}}, 'unavailable'],
    [{principal: {...principal, cloudflareAccountId: 'b'.repeat(32)}}, 'unavailable'],
    [{site: {...site, pagesProjectName: '../projects'}}, 'unavailable'],
    [{site: {...site, repositoryId: '42'}}, 'unavailable'],
    [{cloudflareAccessToken: ''}, 'reauthorization-required'],
    [{assertCurrentAuthorization: undefined}, 'reauthorization-required'],
    [{assertCurrentAuthorization: async () => false}, 'reauthorization-required']
  ];
  for (const [overrides, state] of cases)
    assert.deepEqual(await readToolkitPreviewStatus(input(fetchFn, overrides)), {state});
  assert.equal(gets, 0);
});

test('account and grant changes during authorization, GET or body read suppress the state', async () => {
  const selected = {...principal};
  const delayed = await readToolkitPreviewStatus(input(
    async () => assert.fail('no GET after a changed account'), {
      principal: selected,
      assertCurrentAuthorization: async () => {
        selected.cloudflareAccountId = 'b'.repeat(32);
        return true;
      }
    }
  ));
  assert.deepEqual(delayed, {state: 'reauthorization-required'});

  for (const phase of ['fetch', 'json']) {
    let current = true;
    const state = await readToolkitPreviewStatus(input(async () => {
      if (phase === 'fetch') current = false;
      return {ok: true, json: async () => {
        current = false;
        return {success: true, result: project(scoped)};
      }};
    }, {assertCurrentAuthorization: async () => current}));
    assert.deepEqual(state, {state: 'reauthorization-required'});
  }
});

test('replacement Pages project, wrong owner or changed build stays unavailable', async () => {
  for (const providerProject of [
    {...project(scoped), id: 'replacement'},
    {...project(scoped), production_branch: 'release'},
    {...project(scoped), uses_functions: true},
    project({...scoped, owner_id: '8'}),
    project({...scoped, repo_id: '042'})
  ]) {
    assert.deepEqual(await readToolkitPreviewStatus(input(async () => pagesResponse(providerProject))),
      {state: 'unavailable'});
  }
});

test('provider failure and malformed metadata do not disclose provider output', async () => {
  const providerDetail = 'fixture-secret-provider-body';
  for (const [status, state, headers] of [
    [401, 'reauthorization-required'], [403, 'permission-required'],
    [403, 'unavailable', {'retry-after': '10'}], [429, 'unavailable'], [404, 'unavailable'],
    [503, 'unavailable'], [302, 'unavailable', {location: 'https://redirect.example.invalid/'}],
    [200, 'unavailable']
  ]) {
    const result = await readToolkitPreviewStatus(input(async () => new Response(providerDetail, {status, headers})));
    assert.deepEqual(result, {state});
    assert.doesNotMatch(renderToolkitPreviewStatus(result), /fixture-secret-provider-body|href=|redirect\.example\.invalid/);
  }
  const failed = await readToolkitPreviewStatus(input(async () => { throw Error(providerDetail); }));
  assert.deepEqual(failed, {state: 'unavailable'});
  assert.match(renderToolkitPreviewStatus({state: '<script>unexpected</script>'}), /Preview settings unavailable/);
  assert.doesNotMatch(renderToolkitPreviewStatus({state: '<script>unexpected</script>'}), /<script>/);
});
