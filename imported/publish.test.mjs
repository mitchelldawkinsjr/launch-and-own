import assert from 'node:assert/strict';
import test from 'node:test';
import { bindApproval } from './approval.mjs';
import { memoryApprovalStore } from './approval-store.mjs';
import { base64Decode, base64Encode, gitBlobSha, sha256Bytes, sha256Text } from './bytes.mjs';
import { parseModelOutput, unrelatedFilesIdentical, validateEdits } from './edits.mjs';
import { inspectSite } from './intelligence.mjs';
import { isolatePreview, previewCredentialKeys, previewResponse } from './preview.mjs';
import { proposeImportedPullRequest } from './pull-request.mjs';
import { assessPublishedRevision, verifyPublishedRevision } from './verify-published.mjs';

const BASE = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const HEAD = 'b'.repeat(40);
const NEXT_TREE = 'd'.repeat(40);
const TOKEN = 'ghs_test_token_value';
const text = value => new TextEncoder().encode(value);

async function approvedProposal() {
  const index = text('<!doctype html><h1>Willow Studio</h1>');
  const css = text(':root { --ink: #1f4b3a; }\n');
  const png = Uint8Array.of(1, 2, 3, 4);
  const files = [
    { path: 'index.html', bytes: index },
    { path: 'photo.png', bytes: png },
    { path: 'styles.css', bytes: css }
  ];
  const inspection = await inspectSite(files);
  const proposal = parseModelOutput(JSON.stringify({
    v: 1,
    requestId: '00000000-0000-4000-8000-000000000001',
    repositoryId: 101,
    baseCommitSha: BASE,
    summary: 'Edit the page',
    edits: [
      { kind: 'text', path: 'public/index.html', expectedBlobSha: await gitBlobSha(index), find: 'Willow Studio', replace: 'River & Pine' },
      { kind: 'css_color', path: 'public/styles.css', expectedBlobSha: await gitBlobSha(css), find: '#1f4b3a', replace: '#8c3a2f' }
    ]
  }));
  const validated = await validateEdits({ baseCommitSha: BASE, files, inspection, proposal, repositoryId: 101 });
  const preview = await isolatePreview({
    files: validated.files, baseCommitSha: BASE, githubUserId: 42, repositoryId: 101, ownerLogin: 'tester'
  });
  const receipt = await bindApproval({
    explicitlyApproved: true, preview, changed: validated.changed, githubUserId: 42, repositoryId: 101,
    ownerLogin: 'tester', repository: 'tester/esp-willow', baseCommitSha: BASE,
    proposalDigest: validated.proposalDigest, approvalId: 'a'.repeat(32)
  });
  return { files, validated, preview, receipt, png };
}

function githubHarness({ main = BASE, corruptReadme = false, moveAfterFirstRead = false, throwOnRef = false, resumeAfterMs = 60_000 } = {}) {
  return approvedProposal().then(async prepared => {
    const readme = text('# site\n');
    const indexSha = await gitBlobSha(prepared.files[0].bytes);
    const cssSha = await gitBlobSha(prepared.files[2].bytes);
    const pngSha = await gitBlobSha(prepared.png);
    const readmeSha = await gitBlobSha(readme);
    const state = { main, ref: null, pulls: [], history: [], corruptReadme, moveAfterFirstRead, mainReads: 0, throwOnRef };
    const blobs = new Map([
      [indexSha, prepared.files[0].bytes],
      [cssSha, prepared.files[2].bytes],
      [pngSha, prepared.png],
      [readmeSha, readme]
    ]);
    const root = '/repos/tester/esp-willow';
    const branch = 'launch-and-own/edit-' + (await sha256Text(prepared.receipt.baseCommitSha + ':' + prepared.receipt.artifactDigest)).slice(0, 20);
    const store = memoryApprovalStore({ resumeAfterMs });
    const baseTree = [
      { path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha },
      { path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40) },
      { path: 'public/index.html', mode: '100644', type: 'blob', sha: indexSha },
      { path: 'public/photo.png', mode: '100644', type: 'blob', sha: pngSha },
      { path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha }
    ];
    const json = (data, status = 200) => Response.json(data, { status });
    const fetchFn = async (url, options = {}) => {
      const method = options.method || 'GET';
      const parsed = new URL(url);
      const path = decodeURIComponent(parsed.pathname);
      const body = options.body ? JSON.parse(options.body) : null;
      state.history.push({ method, path, body });
      if (parsed.hostname !== 'api.github.com') throw new Error('wrong host');
      if (path.includes('/merge')) throw new Error('merge attempted');
      if (JSON.stringify(body || {}).includes(TOKEN)) throw new Error('token entered the request body');
      if (path === '/user') return json({ login: 'tester', id: 42 });
      if (path === root && method === 'GET') return json({
        id: 101, name: 'esp-willow', private: true, default_branch: 'main',
        description: 'Launch & Own managed site: willow', owner: { login: 'tester', id: 42 }
      });
      if (path === root + '/branches/main') {
        state.mainReads += 1;
        if (state.moveAfterFirstRead && state.mainReads > 1) return json({ commit: { sha: 'e'.repeat(40) } });
        return json({ commit: { sha: state.main } });
      }
      if (path === root + '/git/commits/' + BASE) return json({ sha: BASE, tree: { sha: TREE } });
      if (path === root + '/git/trees/' + TREE) return json({ sha: TREE, truncated: false, tree: baseTree });
      if (path.startsWith(root + '/git/blobs/') && method === 'GET') {
        const sha = path.slice((root + '/git/blobs/').length);
        const bytes = blobs.get(sha);
        if (!bytes) return json({}, 404);
        return json({ sha, encoding: 'base64', content: base64Encode(bytes) });
      }
      if (path === root + '/git/ref/heads/' + branch && method === 'GET') {
        return state.ref ? json({ object: { sha: state.ref, type: 'commit' } }) : json({}, 404);
      }
      if (path === root + '/git/refs' && method === 'POST') {
        if (state.throwOnRef) {
          state.throwOnRef = false;
          return json({ message: 'unavailable' }, 500);
        }
        assert.equal(body.sha, BASE);
        state.ref = BASE;
        return json({ ref: body.ref, object: { sha: BASE } }, 201);
      }
      if (path === root + '/git/blobs' && method === 'POST') {
        const bytes = base64Decode(body.content);
        const sha = await gitBlobSha(bytes);
        blobs.set(sha, bytes);
        return json({ sha }, 201);
      }
      if (path === root + '/git/trees' && method === 'POST') {
        assert.equal(body.base_tree, TREE);
        return json({ sha: NEXT_TREE }, 201);
      }
      if (path === root + '/git/commits' && method === 'POST') {
        assert.deepEqual(body.parents, [BASE]);
        state.ref = HEAD;
        return json({ sha: HEAD }, 201);
      }
      if (path === root + '/git/refs/heads/' + branch && method === 'PATCH') {
        state.ref = body.sha;
        return json({ object: { sha: body.sha } });
      }
      if (path === root + '/commits/' + HEAD) {
        const files = [
          { filename: 'public/index.html', status: 'modified', sha: await gitBlobSha(prepared.validated.files[0].bytes) },
          { filename: 'public/styles.css', status: 'modified', sha: await gitBlobSha(prepared.validated.files[2].bytes) }
        ];
        return json({ sha: HEAD, parents: [{ sha: BASE }], commit: { tree: { sha: NEXT_TREE } }, files });
      }
      if (path === root + '/git/trees/' + NEXT_TREE) {
        return json({
          sha: NEXT_TREE, truncated: false,
          tree: [
            { path: 'README.md', mode: '100644', type: 'blob', sha: state.corruptReadme ? 'f'.repeat(40) : readmeSha },
            { path: 'public', mode: '040000', type: 'tree', sha: '1'.repeat(40) },
            { path: 'public/index.html', mode: '100644', type: 'blob', sha: await gitBlobSha(prepared.validated.files[0].bytes) },
            { path: 'public/photo.png', mode: '100644', type: 'blob', sha: pngSha },
            { path: 'public/styles.css', mode: '100644', type: 'blob', sha: await gitBlobSha(prepared.validated.files[2].bytes) }
          ]
        });
      }
      if (path === root + '/pulls' && method === 'GET') return json(state.pulls);
      if (path === root + '/pulls' && method === 'POST') {
        assert.equal(body.base, 'main');
        assert.match(body.body, /does not merge/);
        assert.equal(body.body.includes(TOKEN), false);
        const pull = {
          number: 7, state: 'open', html_url: 'https://github.com/tester/esp-willow/pull/7',
          head: { ref: body.head, sha: HEAD, repo: { id: 101 } },
          base: { ref: 'main', sha: BASE, repo: { id: 101 } }
        };
        state.pulls.push(pull);
        return json(pull, 201);
      }
      throw new Error('unexpected ' + method + ' ' + path);
    };
    return { ...prepared, fetchFn, state, store };
  });
}

test('preview carries no credentials and approval is bound to the owner, repo, base, and digests', async () => {
  const { validated, preview, png } = await approvedProposal();
  assert.deepEqual(previewCredentialKeys(preview), []);
  assert.equal(preview.credentialsIncluded, false);
  const response = previewResponse(preview, '/index.html');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-security-policy'], /script-src 'none'/);
  assert.equal(response.headers.authorization, undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(previewResponse(preview, '/../README.md').status, 404);
  assert.equal(unrelatedFilesIdentical(validated.files, preview.files, ['index.html', 'styles.css']), true);
  assert.equal(preview.files.find(file => file.path === 'photo.png').bytes, png);
  await assert.rejects(bindApproval({
    explicitlyApproved: false, preview, changed: validated.changed, githubUserId: 42, repositoryId: 101,
    ownerLogin: 'tester', repository: 'tester/esp-willow', baseCommitSha: BASE
  }), /approval-required/);
});

test('opens one idempotent pull request, reuses it, and never merges', async () => {
  const harness = await githubHarness();
  const proposal = { baseFiles: harness.files, nextFiles: harness.validated.files };
  const options = { githubToken: TOKEN, fetchFn: harness.fetchFn, approvalStore: harness.store };
  const first = await proposeImportedPullRequest(harness.receipt, proposal, options);
  assert.equal(first.status, 'pr_open');
  assert.equal(first.live, false);
  assert.equal(first.merged, false);
  assert.equal(first.reused, false);
  assert.equal(first.pullRequest, 'https://github.com/tester/esp-willow/pull/7');
  assert.equal(harness.receipt.owner.provider, 'github');
  assert.equal(harness.receipt.owner.id, '42');
  const writes = harness.state.history.filter(call => call.method !== 'GET');
  await assert.rejects(proposeImportedPullRequest(harness.receipt, proposal, options), /approval_consumed/);
  assert.equal(harness.state.history.filter(call => call.method !== 'GET').length, writes.length);
  const again = await bindApproval({
    explicitlyApproved: true, preview: harness.preview, changed: harness.validated.changed, githubUserId: 42,
    repositoryId: 101, ownerLogin: 'tester', repository: 'tester/esp-willow', baseCommitSha: BASE,
    proposalDigest: harness.receipt.proposalDigest, approvalId: 'b'.repeat(32), expiresAt: harness.receipt.expiresAt
  });
  const second = await proposeImportedPullRequest(again, proposal, options);
  assert.equal(second.reused, true);
  assert.equal(second.number, 7);
  assert.equal(harness.state.history.filter(call => call.method !== 'GET').length, writes.length);
  assert.equal(harness.state.history.some(call => call.path.includes('/merge')), false);
  harness.state.pulls[0].state = 'closed';
  const third = await bindApproval({
    explicitlyApproved: true, preview: harness.preview, changed: harness.validated.changed, githubUserId: 42,
    repositoryId: 101, ownerLogin: 'tester', repository: 'tester/esp-willow', baseCommitSha: BASE,
    proposalDigest: harness.receipt.proposalDigest, approvalId: 'c'.repeat(32), expiresAt: harness.receipt.expiresAt
  });
  await assert.rejects(proposeImportedPullRequest(third, proposal, options), /pull-request-needs-review/);
});

test('the same owner can finish a claim that died before the branch existed', async () => {
  const stalled = await githubHarness({ throwOnRef: true, resumeAfterMs: 0 });
  const proposal = { baseFiles: stalled.files, nextFiles: stalled.validated.files };
  const options = { githubToken: TOKEN, fetchFn: stalled.fetchFn, approvalStore: stalled.store };
  await assert.rejects(proposeImportedPullRequest(stalled.receipt, proposal, options), /github-write-failed/);
  assert.equal(stalled.state.ref, null);
  const again = await bindApproval({
    explicitlyApproved: true, preview: stalled.preview, changed: stalled.validated.changed, githubUserId: 42,
    repositoryId: 101, ownerLogin: 'tester', repository: 'tester/esp-willow', baseCommitSha: BASE,
    proposalDigest: stalled.receipt.proposalDigest, approvalId: 'd'.repeat(32), expiresAt: stalled.receipt.expiresAt
  });
  const saved = await proposeImportedPullRequest(again, proposal, options);
  assert.equal(saved.reused, false);
  assert.equal(saved.number, 7);
  assert.equal(saved.live, false);
});

test('stops when main moved or an unrelated blob changed', async () => {
  const stale = await githubHarness({ main: 'e'.repeat(40) });
  const proposal = { baseFiles: stale.files, nextFiles: stale.validated.files };
  await assert.rejects(proposeImportedPullRequest(stale.receipt, proposal, { githubToken: TOKEN, fetchFn: stale.fetchFn, approvalStore: stale.store }), /stale_base/);
  assert.equal(stale.state.history.some(call => call.method !== 'GET'), false);
  const raced = await githubHarness({ moveAfterFirstRead: true });
  await assert.rejects(proposeImportedPullRequest(raced.receipt, { baseFiles: raced.files, nextFiles: raced.validated.files }, {
    githubToken: TOKEN, fetchFn: raced.fetchFn, approvalStore: raced.store
  }), /stale_base/);
  assert.equal(raced.state.history.some(call => call.method !== 'GET'), false);

  const corrupt = await githubHarness({ corruptReadme: true });
  await assert.rejects(proposeImportedPullRequest(corrupt.receipt, { baseFiles: corrupt.files, nextFiles: corrupt.validated.files }, {
    githubToken: TOKEN, fetchFn: corrupt.fetchFn, approvalStore: corrupt.store
  }), /unrelated_change/);
  assert.equal(corrupt.state.pulls.length, 0);
});

test('reports live only after the published revision matches', async () => {
  const deployment = (commit, status = 'success') => ({
    canonical_deployment: {
      environment: 'production',
      latest_stage: { name: 'deploy', status },
      deployment_trigger: { metadata: { commit_hash: commit } }
    }
  });
  const pending = assessPublishedRevision({ expectedCommitSha: HEAD, project: deployment(BASE) });
  assert.equal(pending.live, false);
  assert.equal(pending.status, 'deploy_unverified');
  assert.equal(assessPublishedRevision({ expectedCommitSha: HEAD, project: deployment(HEAD, 'active') }).live, false);
  assert.deepEqual(assessPublishedRevision({ expectedCommitSha: HEAD, project: deployment(HEAD) }), {
    live: true, status: 'live', deployedCommit: HEAD
  });

  const bytes = text('<h1>River & Pine</h1>');
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('api.cloudflare.com')) {
      return Response.json({ success: true, result: { name: 'esp-willow-site', ...deployment(HEAD) } });
    }
    return new Response(bytes);
  };
  const verified = await verifyPublishedRevision({
    accountId: 'a'.repeat(32), projectName: 'esp-willow-site', expectedCommitSha: HEAD,
    cloudflareToken: 'cf-secret-token', fetchFn, publicUrl: 'https://esp-willow-site.pages.dev/', expectedBytes: bytes
  });
  assert.equal(verified.live, true);
  assert.equal(calls.every(call => call.method === 'GET' && !call.url.includes('cf-secret-token')), true);
  const mismatch = await verifyPublishedRevision({
    accountId: 'a'.repeat(32), projectName: 'esp-willow-site', expectedCommitSha: HEAD,
    cloudflareToken: 'cf-secret-token', fetchFn, publicUrl: 'https://esp-willow-site.pages.dev/',
    expectedBytes: text('<h1>Other</h1>')
  });
  assert.equal(mismatch.live, false);
  assert.equal(mismatch.status, 'deploy_unverified');
  const hash = await sha256Bytes(bytes);
  const hashed = await verifyPublishedRevision({
    accountId: 'a'.repeat(32), projectName: 'esp-willow-site', expectedCommitSha: HEAD,
    cloudflareToken: 'cf-secret-token', fetchFn, publicUrl: 'https://esp-willow-site.pages.dev/',
    changedFiles: [{ path: 'public/index.html', sha256: hash }]
  });
  assert.equal(hashed.live, true);
  const drifted = await verifyPublishedRevision({
    accountId: 'a'.repeat(32), projectName: 'esp-willow-site', expectedCommitSha: HEAD,
    cloudflareToken: 'cf-secret-token', fetchFn, publicUrl: 'https://esp-willow-site.pages.dev/',
    changedFiles: [{ path: 'public/index.html', sha256: 'b'.repeat(64) }]
  });
  assert.equal(drifted.live, false);
  assert.equal(drifted.status, 'deploy_unverified');
});
