import test from 'node:test';
import assert from 'node:assert/strict';
import { publishSiteFiles, SiteFilesRefused } from './publish-site-files.mjs';
import { buildSiteFilesProposal } from './site-files-proposal.mjs';
import { managedRepositoryDescription } from './managed-site-repository.mjs';
import { gitBlobSha } from '../imported/bytes.mjs';

const BASE = 'a'.repeat(40), TREE = 'b'.repeat(40), NEXT_TREE = 'c'.repeat(40), HEAD = 'd'.repeat(40);
const JOB = '11111111-2222-4333-8444-555555555555';
const owner = 'willow', repoName = 'esp-willow', repositoryId = 42;

function github({paths = ['public/index.html', 'public/about/index.html'], directories = [], mergeStatus = 200, extraHeadFile = false, mainMoves = false} = {}) {
  const calls = [];
  let blobs = [], mainReads = 0;
  const fetchFn = async (url, init = {}) => {
    const path = new URL(url).pathname, method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(method + ' ' + path.replace('/repos/willow/esp-willow', ''));
    const ok = v => Response.json(v);
    if (path === '/repos/willow/esp-willow') return ok({id: repositoryId, private: true, name: repoName, default_branch: 'main',
      owner: {login: owner}, description: managedRepositoryDescription('willow', JOB)});
    if (path.endsWith('/branches/main')) return ok({commit: {sha: mainMoves && ++mainReads > 1 ? 'e'.repeat(40) : BASE}});
    if (path.endsWith('/git/commits/' + BASE)) return ok({sha: BASE, tree: {sha: TREE}});
    if (path.endsWith('/git/trees/' + TREE)) return ok({truncated: false, tree: [
      ...paths.map(path => ({path, type: 'blob'})), ...directories.map(path => ({path, type: 'tree'}))]});
    if (path.endsWith('/git/blobs') && method === 'POST') {
      const sha = await gitBlobSha(Uint8Array.from(atob(body.content), c => c.charCodeAt(0)));
      blobs.push(sha); return ok({sha});
    }
    if (path.endsWith('/git/trees') && method === 'POST') { assert.equal(body.base_tree, TREE); return ok({sha: NEXT_TREE}); }
    if (path.endsWith('/git/commits') && method === 'POST') { assert.deepEqual(body.parents, [BASE]); return ok({sha: HEAD}); }
    if (path.endsWith('/git/refs') && method === 'POST') return ok({ref: body.ref});
    if (path.endsWith('/commits/' + HEAD)) return ok({sha: HEAD, parents: [{sha: BASE}], files: [
      ...['public/robots.txt', 'public/sitemap.xml'].map((filename, i) => ({filename, status: 'added', sha: blobs[i]})),
      ...(extraHeadFile ? [{filename: 'public/index.html', status: 'modified', sha: 'f'.repeat(40)}] : [])]});
    if (path.endsWith('/pulls') && method === 'POST') return ok({number: 7, html_url: 'https://github.com/willow/esp-willow/pull/7', head: {sha: HEAD}});
    if (path.endsWith('/pulls/7/merge')) return mergeStatus === 200 ? ok({merged: true, sha: '9'.repeat(40)}) : new Response('{}', {status: mergeStatus});
    throw new Error('unexpected ' + method + ' ' + path);
  };
  return {fetchFn, calls};
}
const propose = paths => buildSiteFilesProposal({kind: 'seo', paths, origin: 'https://willow.example'});
const digestFor = async paths => (await propose(paths)).digest;
const input = async (extra = {}) => ({owner, repoName, repositoryId, propose,
  approvedDigest: await digestFor(['public/index.html', 'public/about/index.html']), merge: true, ...extra});

test('adds exactly the approved files on a branch, opens a PR and merges it', async () => {
  const gh = github();
  const r = await publishSiteFiles(await input(), {githubToken: 't', fetchFn: gh.fetchFn});
  assert.deepEqual(r, {number: 7, url: 'https://github.com/willow/esp-willow/pull/7', merged: true, mergeNote: null,
    files: ['public/robots.txt', 'public/sitemap.xml']});
  assert.ok(gh.calls.includes('PUT /pulls/7/merge'));
  assert.ok(gh.calls.indexOf('POST /git/refs') > gh.calls.indexOf('POST /git/commits'), 'the branch only ever points at the approved commit');
});

test('"open a pull request instead" never merges; a blocked merge leaves the PR open', async () => {
  const pr = github();
  assert.equal((await publishSiteFiles(await input({merge: false}), {githubToken: 't', fetchFn: pr.fetchFn})).merged, false);
  assert.ok(!pr.calls.some(c => c.includes('/merge')));
  const blocked = await publishSiteFiles(await input(), {githubToken: 't', fetchFn: github({mergeStatus: 405}).fetchFn});
  assert.equal(blocked.merged, false); assert.equal(blocked.mergeNote, 'merge_blocked');
});

test('refuses an outdated review or repository and prevents unrelated changes from reaching a PR', async () => {
  for (const [opts, extra, code, writes] of [
    [{paths: ['public/index.html']}, {}, 'approval_digest_mismatch', false],
    [{paths: ['public/index.html', 'public/about/index.html', 'public/robots.txt']}, {}, 'approval_digest_mismatch', false],
    [{paths: ['public/index.html', 'public/robots.txt', 'public/sitemap.xml']}, {}, 'already_present', false],
    [{directories: ['public/sitemap.xml']}, {}, 'file_exists', false],
    [{}, {approvedBaseSha: 'f'.repeat(40)}, 'approval_digest_mismatch', false],
    [{extraHeadFile: true}, {}, 'unrelated_change', true],
    [{}, {repositoryId: 43}, 'repository_mismatch', false]
  ]) {
    const gh = github(opts);
    await assert.rejects(publishSiteFiles(await input(extra), {githubToken: 't', fetchFn: gh.fetchFn}),
      e => e instanceof SiteFilesRefused && e.code === code, code);
    assert.equal(gh.calls.some(c => c.startsWith('POST')), writes, code);
    assert.ok(!gh.calls.some(c => c.includes('/pulls')), code + ': no PR');
  }
});

test('a stale base is never merged', async () => {
  const r = await publishSiteFiles(await input(), {githubToken: 't', fetchFn: github({mainMoves: true}).fetchFn});
  assert.equal(r.merged, false); assert.equal(r.mergeNote, 'stale_base');
});
