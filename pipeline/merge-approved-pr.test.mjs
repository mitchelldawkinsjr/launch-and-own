import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MergeRefused, mergeVerifiedPullRequest } from './merge-approved-pr.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), MERGED = 'c'.repeat(40);
const target = { owner: 'tester', repoName: 'esp-willow', number: 7, headCommitSha: HEAD, baseCommitSha: BASE };

function gh({ main = BASE, mergeStatus = 200, mergeBody = { merged: true, sha: MERGED } } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/branches/main')) return Response.json({ commit: { sha: main } });
    if (url.endsWith('/pulls/7/merge')) return Response.json(mergeBody, { status: mergeStatus });
    throw Error('unexpected ' + url);
  };
  return { calls, fetchFn };
}

test('merges exactly the approved head with the sha guard, squash, once', async () => {
  const { calls, fetchFn } = gh();
  assert.deepEqual(await mergeVerifiedPullRequest(target, { githubToken: 't', fetchFn }), { merged: true, mergedCommitSha: MERGED });
  const merge = calls.find(c => c.method === 'PUT');
  assert.equal(merge.url, 'https://api.github.com/repos/tester/esp-willow/pulls/7/merge');
  assert.equal(merge.body.sha, HEAD);
  assert.equal(merge.body.merge_method, 'squash');
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

test('refuses to merge when main moved after approval (no merge call)', async () => {
  const { calls, fetchFn } = gh({ main: 'e'.repeat(40) });
  await assert.rejects(mergeVerifiedPullRequest(target, { githubToken: 't', fetchFn }), e => e instanceof MergeRefused && e.code === 'stale_base');
  assert.equal(calls.some(c => c.method === 'PUT'), false);
});

test('GitHub refusals leave the PR open as merge_blocked; auth loss is credentials_revoked', async () => {
  for (const status of [403, 405, 409, 422, 500]) {
    await assert.rejects(mergeVerifiedPullRequest(target, { githubToken: 't', fetchFn: gh({ mergeStatus: status }).fetchFn }), e => e.code === 'merge_blocked', String(status));
  }
  for (const status of [401, 404]) {
    await assert.rejects(mergeVerifiedPullRequest(target, { githubToken: 't', fetchFn: gh({ mergeStatus: status }).fetchFn }), e => e.code === 'credentials_revoked', String(status));
  }
  await assert.rejects(mergeVerifiedPullRequest(target, { githubToken: 't', fetchFn: gh({ mergeBody: { merged: false } }).fetchFn }), e => e.code === 'merge_blocked');
});

test('malformed targets are refused before any request', async () => {
  const { calls, fetchFn } = gh();
  for (const bad of [{ number: 0 }, { headCommitSha: 'x' }, { owner: '../evil' }, { repoName: '' }]) {
    await assert.rejects(mergeVerifiedPullRequest({ ...target, ...bad }, { githubToken: 't', fetchFn }), e => e.code === 'merge_blocked');
  }
  await assert.rejects(mergeVerifiedPullRequest(target, { githubToken: '', fetchFn }), e => e.code === 'merge_blocked');
  assert.equal(calls.length, 0);
});
