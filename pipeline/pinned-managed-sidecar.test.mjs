import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PinnedSidecarError, PINNED_MANAGED_SIDECAR_PATH, readPinnedManagedSidecar}
  from './pinned-managed-sidecar.mjs';

const owner = 'test-owner', repoName = 'esp-willow-studio';
const projectName = repoName + '-site', projectId = 'project-immutable-87';
const repoId = 452, userId = 17, account = 'a'.repeat(32);
const head = 'c'.repeat(40), moved = 'd'.repeat(40);
const html = '<!doctype html><html><body>Current managed website</body></html>';
const rawSidecar = JSON.stringify({
  schema: 'launch-and-own/site-config', version: 1,
  site: {name: 'Willow Studio', tagline: 'Current managed website',
    about: 'A demo', services: [], theme: 'ocean', contactEmail: ''},
  htmlSha256: createHash('sha256').update(html).digest('hex')
}, null, 2) + '\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const githubRoot = '/repos/' + owner + '/' + repoName;
const cloudflareRoot = '/accounts/' + account + '/pages/projects/' + projectName;
const sidecarPath = githubRoot + '/contents/.launch-and-own/site-config.json';
const bytesFile = (data, blob = 'b'.repeat(40)) => ({
  type: 'file', encoding: 'base64', content: Buffer.from(data).toString('base64'),
  size: Buffer.byteLength(data), sha: blob
});
const response = (value, status=200, headers={}) => new Response(JSON.stringify(value),
  {status, headers: {'content-type': 'application/json', ...headers}});
const fixtures = () => ({
  principal: {githubUserId: userId, githubLogin: owner, cloudflareAccountId: account},
  reference: {
    siteId: 'managed_' + repoId + '_' + projectId,
    githubUserId: userId, githubOwner: owner, cloudflareAccountId: account,
    repositoryId: repoId, repositoryName: repoName,
    pagesProjectId: projectId, pagesProjectName: projectName,
    branch: 'main', productionBranch: 'main', sourceKind: 'managed-existing',
    baseCommitSha: head
  },
  user: {id: userId, login: owner, email: 'hidden@secret.test'},
  repo: {id: repoId, name: repoName, private: true, default_branch: 'main',
    owner: {id: userId, login: owner},
    description: 'Launch & Own managed site: willow-studio [job:12345678-1234-1234-1234-123456789abc]'},
  branch: {commit: {sha: head}},
  project: {id: projectId, name: projectName, subdomain: projectName + '.pages.dev',
    production_branch: 'main', uses_functions: false,
    source: {type: 'github', config: {owner, owner_id: String(userId), repo_name: repoName,
      repo_id: String(repoId), production_deployments_enabled: true}},
    build_config: {root_dir: '/', build_command: '', destination_dir: 'public'},
    canonical_deployment: {environment: 'production', latest_stage: {
      name: 'deploy', status: 'success'}, deployment_trigger: {
      metadata: {commit_hash: head}}}},
  homepage: bytesFile(html),
  sidecar: bytesFile(rawSidecar),
  exists: true
});
function harness() {
  const f = fixtures(), calls = [], checks = [], custom = new Map();
  let allowed = true, branchReads = 0;
  const assertCurrentAuthorization = async frozen => {
    checks.push(frozen);
    return allowed;
  };
  async function fetchFn(url, options) {
    calls.push({url, options});
    const u = new URL(url);
    const p = u.pathname.replace('/client/v4', '');
    if (custom.has(p)) return custom.get(p)(u, options);
    if (u.host === 'api.github.com') {
      if (p === '/user') return response(f.user);
      if (p === githubRoot) return response(f.repo);
      if (p === githubRoot + '/branches/main') {
        branchReads++; return response(f.branch);
      }
      if (p === githubRoot + '/contents/public/index.html') return response(f.homepage);
      if (p === sidecarPath) return f.exists ? response(f.sidecar) : response({message: 'Not Found'}, 404);
      return response({message: 'Not Found'}, 404);
    }
    if (u.host === 'api.cloudflare.com') {
      if (p === cloudflareRoot) return response({success: true, result: f.project});
      return response({success: false}, 404);
    }
    throw Error('Unexpected provider host');
  }
  const data = {
    principal: f.principal, reference: f.reference, siteId: f.reference.siteId,
    githubAccessToken: 'gh-private-secret', cloudflareAccessToken: 'cf-private-secret',
    assertCurrentAuthorization, fetchFn
  };
  return {f, calls, checks, custom, data,
    revoke: () => {allowed = false;},
    getBranchReads: () => branchReads,
    read: (overrides = {}) => readPinnedManagedSidecar({...data, ...overrides})};
}
const code = expected => err => {
  assert(err instanceof PinnedSidecarError);
  assert.equal(err.code, expected);
  assert(!err.message.includes('gh-private-secret'));
  return true;
};

test('current managed source + exact sidecar bytes are returned backend-internally only', async () => {
  const h = harness();
  const result = await h.read();
  assert.equal(result.status, 'pinned_sidecar_evidence_verified');
  assert.equal(result.currentSource.status, 'github_current_source_verified');
  assert.equal(result.currentSource.html, html);
  assert.equal(result.currentSource.homepageHtmlSha256, sha(html));
  assert.equal(result.sidecarRaw, rawSidecar);
  assert.deepEqual(result.sidecarEvidence, {
    path: PINNED_MANAGED_SIDECAR_PATH,
    siteId: h.f.reference.siteId, refCommitSha: head,
    exists: true, blobSha: h.f.sidecar.sha,
    contentSha256: sha(rawSidecar)
  });
  assert.equal(result.historicalContinuityVerified, false);
  assert.equal(result.editorEligible, false);
  assert.equal(result.providerWriteAuthorized, false);
  assert.equal(h.calls.length, 12);
  assert.equal(h.getBranchReads(), 3);
  assert(h.calls.every(c => c.options.method === 'GET' && c.options.redirect === 'manual'));
  assert(h.calls.every(c => c.url.startsWith('https://api.github.com/') ||
    c.url.startsWith('https://api.cloudflare.com/client/v4/')));
  assert(h.calls.some(c => c.url.includes('/site-config.json?ref=' + head)));
  assert(h.checks.length >= 3 * h.calls.length);
  assert(h.checks.every(x => Object.isFrozen(x)));
  for (const secret of ['gh-private-secret', 'cf-private-secret',
    'hidden@secret.test', 'authorization'])
    assert(!JSON.stringify(result).includes(secret));
});

test('an authenticated 404 is exact pinned absence, not permission or a fake sidecar', async () => {
  const h = harness(); h.f.exists = false;
  const result = await h.read();
  assert.deepEqual(result.sidecarEvidence, {
    path: PINNED_MANAGED_SIDECAR_PATH,
    siteId: h.f.reference.siteId, refCommitSha: head, exists: false
  });
  assert.equal(result.sidecarRaw, null);
  assert.equal(result.editorEligible, false);
  assert.equal(h.calls.length, 12);
});

test('sidecar content digest preserves exact UTF-8 bytes including BOM', async () => {
  const h = harness();
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rawSidecar)]);
  h.f.sidecar = bytesFile(bom);
  const result = await h.read();
  assert.equal(result.sidecarEvidence.contentSha256, sha(bom));
  assert.equal(result.sidecarRaw.codePointAt(0), 0xfeff);
  assert.equal(result.sidecarRaw.slice(1), rawSidecar);
});

test('sidecar malformed base64, invalid UTF-8, oversize, and unknown blob never pass', async () => {
  for (const change of [
    f => {f.sidecar.encoding='utf8';},
    f => {f.sidecar.size=16*1024+1;},
    f => {f.sidecar.content='!!notbase64!!';},
    f => {f.sidecar.size=1;},
    f => {f.sidecar.sha='short';},
    f => {f.sidecar=bytesFile(Buffer.from([0xff]));}
  ]) {
    const h=harness(); change(h.f);
    await assert.rejects(h.read(),code('sidecar_content_unverifiable'));
  }
});

test('revocation immediately before sidecar GET denies any sidecar evidence', async () => {
  const h=harness(); let visited=false;
  h.custom.set(sidecarPath, async () => {
    visited=true;h.revoke();
    return response(h.f.sidecar);
  });
  await assert.rejects(h.read(), code('authorization_changed'));
  assert.equal(visited,true);
});

test('changed selected principal or server-held ref during sidecar GET is rejected', async () => {
  for (const change of [
    h => {h.f.principal.cloudflareAccountId='f'.repeat(32);},
    h => {h.f.reference.repositoryId=999;},
    h => {h.f.reference.baseCommitSha=moved;}
  ]) {
    const h=harness();
    h.custom.set(sidecarPath, async () => {
      change(h);
      return response(h.f.sidecar);
    });
    await assert.rejects(h.read(),code('verified_reference_changed'));
  }
});

test('moved main after sidecar read rejects otherwise valid pinned file', async () => {
  const h=harness();
  h.custom.set(sidecarPath, async () => {
    h.f.branch.commit.sha=moved;
    return response(h.f.sidecar);
  });
  await assert.rejects(h.read(),code('current_source_changed'));
});

test('same-name replaced GitHub repository or Pages project after sidecar read rejects', async () => {
  for (const change of [
    f => {f.repo.id=998;},
    f => {f.repo.owner.id=18;},
    f => {f.project.id='replacement-project';},
    f => {f.project.source.config.repo_id='999';},
    f => {f.project.source.config.owner_id='18';},
    f => {f.project.build_config.destination_dir='dist';}
  ]) {
    const h=harness();
    h.custom.set(sidecarPath, async () => {
      change(h.f);
      return response(h.f.sidecar);
    });
    await assert.rejects(h.read(),code('current_source_changed'));
  }
});

test('a stale or wrong owner reference is denied before sidecar GET', async () => {
  for (const [override, expected] of [
    [{siteId: 'managed_999_elsewhere'}, 'current_source_unavailable'],
    [{reference: {...fixtures().reference, repositoryId:999}}, 'current_source_unavailable'],
    [{principal: {...fixtures().principal, githubUserId: 99}}, 'current_source_unavailable'],
    [{reference: {...fixtures().reference, cloudflareAccountId:'f'.repeat(32)}},
      'current_source_unavailable'],
    [{reference: {...fixtures().reference, baseCommitSha:moved}}, 'current_source_changed']
  ]) {
    const h=harness();
    await assert.rejects(h.read(override),code(expected));
    assert(!h.calls.some(c => c.url.includes('/site-config.json')));
  }
});

test('provider sidecar 401/403/rate limit/5xx and malformed JSON never imply absence', async () => {
  for (const [status, headers, expected] of [
    [401, {}, 'github_reauthorization_required'],
    [403, {}, 'github_permission_denied'],
    [403, {'retry-after':'8'}, 'github_rate_limited'],
    [403, {'x-ratelimit-remaining':'0'}, 'github_rate_limited'],
    [429, {}, 'github_rate_limited'],
    [503, {}, 'github_temporarily_unavailable']
  ]) {
    const h=harness();
    h.custom.set(sidecarPath, async () => response({message:'private token'},status,headers));
    await assert.rejects(h.read(),code(expected));
  }
  const h=harness();
  h.custom.set(sidecarPath, async () => new Response('not json',{status:200}));
  await assert.rejects(h.read(),code('github_unexpected_response'));
});

test('redirect and token-bearing transport errors are safe and produce no sidecar', async () => {
  const h=harness();
  h.custom.set(sidecarPath, async () => new Response(null,{
    status:302,headers:{location:'https://attacker.example/'}
  }));
  await assert.rejects(h.read(),code('github_temporarily_unavailable'));
  const n=harness();
  n.custom.set(sidecarPath, async () => {throw Error('Bearer gh-private-secret');});
  await assert.rejects(n.read(),code('github_temporarily_unavailable'));
});

test('rejected/expired authorization before any provider call fails closed', async () => {
  const h=harness();h.revoke();
  await assert.rejects(h.read(),code('authorization_changed'));
  assert.equal(h.calls.length,0);
});

test('raw sidecar stays untrusted and no code path creates a feature branch or approval', async () => {
  const h=harness();
  const result=await h.read();
  assert.equal(result.editorEligible,false);
  assert.equal(result.providerWriteAuthorized,false);
  assert(!Object.hasOwn(result,'approved'));
  assert(!Object.hasOwn(result,'reviewDigest'));
  assert(!Object.hasOwn(result,'pullRequest'));
  assert(h.calls.every(x=>x.options.method==='GET'));
});
