import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverOwnedManagedSites, readCurrentManagedHomepage, ManagedSiteInventoryError}
  from './owned-site-inventory.mjs';

const accountId = 'a'.repeat(32), otherAccount = 'b'.repeat(32);
const head = 'c'.repeat(40), movedHead = 'd'.repeat(40);
const repoName = 'esp-willow-studio', projectName = repoName + '-site';
const projectId = 'project-immutable-87', repoId = 452;
const html = '<!doctype html><html><head></head><body>Latest approved copy</body></html>';
const identity = {githubUserId: 17, githubLogin: 'test-owner', cloudflareAccountId: accountId};
const keys = {githubAccessToken: 'gh-private-secret', cloudflareAccessToken: 'cf-private-secret'};
const root = '/repos/' + identity.githubLogin + '/' + repoName;
const cfRoot = '/accounts/' + accountId + '/pages/projects';
const clone = data => structuredClone(data);

function fixtures() {
  return {
    principal: clone(identity),
    user: {id: 17, login: 'test-owner', email: 'private@example.test'},
    repo: {id: repoId, name: repoName, private: true, default_branch: 'main',
      owner: {id: 17, login: 'test-owner'},
      description: 'Launch & Own managed site: willow-studio [job:12345678-1234-1234-1234-123456789abc]',
      private_secret: 'do-not-export'},
    branch: {commit: {sha: head}},
    project: {id: projectId, name: projectName, subdomain: projectName + '.pages.dev',
      production_branch: 'main', uses_functions: false,
      source: {type: 'github', config: {owner: 'test-owner', owner_id: '17',
        repo_id: '452', repo_name: repoName, production_deployments_enabled: true,
        preview_deployment_setting: 'none'}},
      build_config: {root_dir: '/', destination_dir: 'public', build_command: '',
        web_analytics_token: 'private-beacon-secret'},
      canonical_deployment: {environment: 'production', latest_stage: {
        name: 'deploy', status: 'success'}, deployment_trigger: {
        metadata: {commit_hash: head}}}},
    content: {type: 'file', encoding: 'base64',
      content: Buffer.from(html, 'utf8').toString('base64'), size: Buffer.byteLength(html),
      sha: '1'.repeat(40)}
  };
}

function fake(f = fixtures()) {
  const calls = [], auth = [], custom = {};
  let authorized = true, branchCalls = 0;
  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
  }
  async function fetchFn(url, options) {
    calls.push({url, options});
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/client/v4', '');
    if (custom[path]) return custom[path](parsed, options);
    if (parsed.host === 'api.github.com') {
      if (path === '/user') return json(f.user);
      if (path === root) return json(f.repo);
      if (path === root + '/branches/main') {branchCalls++;return json(f.branch);}
      if (path === root + '/contents/public/index.html') return json(f.content);
      return json({message: 'not found'}, 404);
    }
    if (parsed.host === 'api.cloudflare.com') {
      if (path === cfRoot) return json({success: true,
        result: [{id: projectId, name: projectName}],
        result_info: {page: 1, per_page: 10, total_pages: 1, total_count: 1}});
      if (path === cfRoot + '/' + projectName) return json({success: true, result: f.project});
      return json({success: false, result: null}, 404);
    }
    throw Error('Unexpected host ' + url);
  }
  const assertCurrentAuthorization = async snapshot => {
    auth.push(snapshot);
    return authorized;
  };
  const base = {principal: f.principal, ...keys, assertCurrentAuthorization, fetchFn};
  return {
    f, calls, auth, custom, base,
    revoke: () => { authorized = false; },
    read: (opts = {}) => discoverOwnedManagedSites({...base, ...opts}),
    source: (opts = {}) => readCurrentManagedHomepage({
      siteId: 'managed_' + repoId + '_' + projectId, ...base, ...opts
    }),
    getBranchCalls: () => branchCalls,
    json
  };
}
function expectCode(code) {
  return e => {
    assert(e instanceof ManagedSiteInventoryError);
    assert.equal(e.code, code);
    return true;
  };
}
test('discovers an existing site after job history expiry without D1, tokens or provider writes', async () => {
  const m = fake();
  const result = await m.read();
  assert.equal(result.status, 'fresh_owner_scoped_inventory');
  assert.equal(result.scanCompleted, true);
  assert.equal(result.accountId, accountId);
  assert.equal(result.sites.length, 1);
  const site = result.sites[0];
  assert.equal(site.siteId, 'managed_' + repoId + '_' + projectId);
  assert.equal(site.repositoryId, repoId);
  assert.equal(site.githubUserId, 17);
  assert.equal(site.githubOwner, 'test-owner');
  assert.equal(site.cloudflareAccountId, accountId);
  assert.equal(site.pagesProjectId, projectId);
  assert.equal(site.baseCommitSha, head);
  assert.equal(site.productionCommitSha, head);
  assert.equal(site.sourceKind, 'managed-existing');
  assert.equal(site.publicationVerified, false);
  assert.equal(site.sourceState, 'github_main_verified_publication_unverified');
  assert.equal(site.repositoryUrl, 'https://github.com/test-owner/' + repoName);
  assert.equal(site.pagesProjectDashboardUrl,
    'https://dash.cloudflare.com/' + accountId + '/pages/view/' + projectName);
  assert(m.calls.every(c => c.options.method === 'GET' && c.options.redirect === 'manual'));
  assert(m.calls.some(c => c.url.includes('?page=1&per_page=10')));
  assert(m.calls.every(c => c.url.startsWith('https://api.github.com/') ||
    c.url.startsWith('https://api.cloudflare.com/client/v4/')));
  assert(m.auth.length >= m.calls.length * 2);
  assert(m.auth.every(x => Object.isFrozen(x) && x.githubUserId === 17));
  const output = JSON.stringify(result);
  for (const secret of Object.values(keys).concat([
    'private@example.test', 'private-beacon-secret', 'do-not-export'
  ])) assert(!output.includes(secret));
});

test('identical page name but replaced repository never enters owner inventory', async () => {
  for (const change of [
    f => {f.repo.id = 999;},
    f => {f.repo.owner.id = 18;},
    f => {f.repo.owner.login = 'different-user';},
    f => {f.repo.name = 'esp-another';},
    f => {f.repo.private = false;},
    f => {f.repo.default_branch = 'develop';},
    f => {f.repo.description = 'Unmanaged private repository';},
    f => {f.project.source.config.repo_id = '00452';},
    f => {f.project.source.config.owner_id = '18';},
    f => {f.project.source.config.owner_id = ['17'];},
    f => {f.project.source.config.owner = 'other-owner';},
    f => {f.project.source.config.repo_name = 'esp-replaced';},
    f => {f.project.id = 'replaced-pages-project';},
    f => {f.project.subdomain = 'unrelated.pages.dev';},
    f => {f.project.uses_functions = true;},
    f => {f.project.build_config.destination_dir = 'dist';}
  ]) {
    const m = fake(), before = clone(m.f);
    change(m.f);
    const result = await m.read();
    assert.equal(result.sites.length, 0, JSON.stringify(m.f) !== JSON.stringify(before) ?
      'wrong project or repo identity admitted' : 'fixture did not change');
  }
});

test('missing optional Pages source owner ID is tolerated only with verified current repo owner', async () => {
  const m = fake();
  delete m.f.project.source.config.owner_id;
  const result = await m.read();
  assert.equal(result.sites.length, 1);
  m.f.repo.owner.id = 999;
  assert.equal((await m.read()).sites.length, 0);
});

test('different selected Cloudflare account never carries old inventory through', async () => {
  const m = fake();
  m.f.principal.cloudflareAccountId = otherAccount;
  m.base.principal = m.f.principal;
  await assert.rejects(m.read(), expectCode('cloudflare_temporarily_unavailable'));
  assert(m.calls.every(c => !c.url.includes(cfRoot)));
  assert(m.calls.some(c => c.url.includes('/accounts/' + otherAccount + '/pages/projects')));
});

test('changed GitHub user identity is rejected before exposing any site', async () => {
  const m = fake();
  m.f.user.id = 18;
  await assert.rejects(m.read(), expectCode('github_owner_mismatch'));
  assert(!m.calls.some(c => c.url.includes('/pages/')));
});

test('client cannot choose a forged account, owner or invalid token identity', async () => {
  const m = fake();
  for (const principal of [
    {...identity, githubUserId: 0},
    {...identity, githubUserId: '17'},
    {...identity, githubLogin: '../../path'},
    {...identity, cloudflareAccountId: '../../other'},
  ]) await assert.rejects(m.read({principal}), expectCode('verified_owner_required'));
  assert.equal(m.calls.length, 0);
});

test('authorization fence is required and has no accepted client-reported boolean fallback', async () => {
  const m = fake();
  await assert.rejects(m.read({assertCurrentAuthorization: undefined}),
    expectCode('authorization_fence_required'));
  assert.equal(m.calls.length, 0);
});

test('revoked grants before request and during provider response fail closed', async () => {
  const m = fake(); m.revoke();
  await assert.rejects(m.read(), expectCode('authorization_changed'));
  assert.equal(m.calls.length, 0);
  const n = fake();n.custom['/user'] = async () => {
    n.revoke();
    return n.json(n.f.user);
  };
  await assert.rejects(n.read(), expectCode('authorization_changed'));
  assert.equal(n.calls.length, 1);
});

test('mutated selected account during provider read refuses results', async () => {
  const m = fake();
  m.custom['/user'] = async () => {
    m.f.principal.cloudflareAccountId = otherAccount;
    return m.json(m.f.user);
  };
  await assert.rejects(m.read(), expectCode('authorization_changed'));
  assert.equal(m.calls.length, 1);
});

test('provider token error and malicious network exception are sanitized', async () => {
  const m = fake();
  m.custom['/user'] = async () => { throw Error('Private credentials ' + keys.githubAccessToken); };
  await assert.rejects(m.read(), expectCode('github_temporarily_unavailable'));
  const n = fake();
  n.custom['/user'] = async () => n.json({}, 401);
  await assert.rejects(n.read(), expectCode('github_reauthorization_required'));
  const o = fake();
  o.custom['/user'] = async () => o.json({}, 403);
  await assert.rejects(o.read(), expectCode('github_permission_denied'));
  const z = fake();
  z.custom['/user'] = async () => z.json({}, 429);
  await assert.rejects(z.read(), expectCode('github_rate_limited'));
});

test('provider redirects, malformed JSON and failed Cloudflare envelopes never become empty inventory', async () => {
  const m = fake();
  m.custom['/user'] = async () => new Response(null, {status: 302, headers: {location: 'https://bad.test'}});
  await assert.rejects(m.read(), expectCode('github_temporarily_unavailable'));
  const n = fake();
  n.custom['/user'] = async () => new Response('{not-json', {status: 200});
  await assert.rejects(n.read(), expectCode('github_unexpected_response'));
  const x = fake();
  x.custom[cfRoot] = async () => x.json({success: false, result: []});
  await assert.rejects(x.read(), expectCode('cloudflare_unexpected_response'));
});

test('Cloudflare pagination reads every bounded page and ignores unrelated projects', async () => {
  const m = fake();
  const first = Array.from({length: 9}, (_, i) => ({id: 'other-' + i, name: 'not-managed-' + i}));
  first.push({id: projectId, name: projectName});
  m.custom[cfRoot] = async url => m.json({success: true,
    result: url.searchParams.get('page') === '1' ? first : [
      {id: 'unrelated-provider', name: 'another-page'}],
    result_info: {page: Number(url.searchParams.get('page')), per_page: 10,
      total_pages: 2, total_count: 11}
  });
  const result = await m.read();
  assert.equal(result.sites.length, 1);
  assert(m.calls.some(c => c.url.includes('?page=2&per_page=10')));
});

test('pagination omissions, duplicate project records and overlarge scans fail closed', async () => {
  const mutations = [
    (m) => m.json({success: true,
      result: Array(10).fill({name: 'unrelated', id: 'whatever'})}),
    (m) => m.json({success: true,
      result: [{id: projectId, name: projectName}, {id: projectId, name: projectName}],
      result_info: {page: 1, total_pages: 1}}),
    (m) => m.json({success: true, result: [],
      result_info: {page: 1, total_pages: 11}}),
    (m) => m.json({success: true, result: [],
      result_info: {page: 2, total_pages: 1}})
  ];
  for (const mutation of mutations) {
    const m = fake();
    m.custom[cfRoot] = async () => mutation(m);
    await assert.rejects(m.read(), expectCode('cloudflare_pagination_unverified'));
  }
});

test('readCurrentManagedHomepage is SHA-pinned to current main, not the original job', async () => {
  const m = fake();
  const source = await m.source();
  assert.equal(source.status, 'github_current_source_verified');
  assert.equal(source.baseCommitSha, head);
  assert.equal(source.html, html);
  assert.equal(source.editMode, 'approved_migration_required');
  assert.equal(source.publicationVerified, false);
  assert.match(source.homepageHtmlSha256, /^[a-f0-9]{64}$/);
  assert.equal(source.homepageGitBlobSha, '1'.repeat(40));
  assert(m.calls.some(c => c.url.includes('/contents/public/index.html?ref=' + head)));
  assert.equal(m.getBranchCalls(), 2, 'main must be re-read after content hash');
});

test('siteId is a selector, never substitute authority for another owner or repo', async () => {
  const m = fake();
  await assert.rejects(m.source({siteId: 'managed_999_other-project'}),
    expectCode('owned_site_not_found'));
  await assert.rejects(m.source({siteId: '../other'}),
    expectCode('invalid_site_selector'));
  const n = fake();
  n.f.repo.owner.id = 99;
  await assert.rejects(n.source(), expectCode('owned_site_not_found'));
});

test('main SHA drift during source read is denied instead of treating old HTML as editable', async () => {
  const m = fake(), orig = m.custom[root + '/branches/main'];
  let times = 0;
  m.custom[root + '/branches/main'] = async () => {
    times++;
    return m.json({commit: {sha: times === 1 ? head : movedHead}});
  };
  await assert.rejects(m.source(), expectCode('current_source_changed'));
});

test('same-name replaced repository or Pages project after source read is refused', async () => {
  const variants = [
    m => {m.f.repo.id = 999;},
    m => {m.f.project.id = 'other-project';},
    m => {m.f.project.source.config.owner_id = '18';}
  ];
  for (const change of variants) {
    const m = fake();
    m.custom[root + '/contents/public/index.html'] = async () => {
      change(m);
      return m.json(m.f.content);
    };
    await assert.rejects(m.source(), expectCode('current_source_changed'));
  }
});

test('non-base64/oversize/binary homepage refuses automatic editing or migration', async () => {
  for (const change of [
    f => {f.content.encoding = 'utf8';},
    f => {f.content.size = 500000;},
    f => {f.content.content = '%%%';},
    f => {f.content.size = 1;},
    f => {f.content.content = Buffer.from([0xff]).toString('base64'); f.content.size = 1;}
  ]) {
    const m = fake(); change(m.f);
    await assert.rejects(m.source(), expectCode('current_source_requires_review'));
  }
});

test('the old site needs a separate approved config migration; no source or provider writes occur', async () => {
  const m = fake();
  const read = await m.source();
  assert.equal(read.editMode, 'approved_migration_required');
  assert.equal(read.publicationVerified, false);
  assert(!Object.hasOwn(read, 'approvedConfig'));
  assert(!Object.hasOwn(read, 'readyToPublish'));
  assert(m.calls.every(x => x.options.method === 'GET'));
  assert(!JSON.stringify(read).includes('gh-private-secret'));
  assert(!JSON.stringify(read).includes('cf-private-secret'));
});

test('revocation after homepage read suppresses the source', async () => {
  const m = fake();
  m.custom[root + '/contents/public/index.html'] = async () => {
    m.revoke();
    return m.json(m.f.content);
  };
  await assert.rejects(m.source(), expectCode('authorization_changed'));
});
