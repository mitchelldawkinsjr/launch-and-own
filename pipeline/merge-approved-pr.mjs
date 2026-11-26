// "Approve and publish" (owner decision, 2026-11-26): merge exactly the pull request an approval just created.
// Callers MUST first re-verify the PR with their flow's reader (readImportedPullRequest / readApprovedUpdatePr):
// deterministic branch, base main, approved head. This helper adds the last two guards and performs the merge:
//   1. main must still equal the approved base commit (else 'stale_base'),
//   2. GitHub's `sha` parameter makes the merge fail if the PR head moved after approval.
// Any refusal leaves the PR open for the owner ('merge_blocked'). It never retries, force-merges or merges anything else.

const SHA = /^[a-f0-9]{40}$/i;
const NAME = /^[A-Za-z0-9_.-]+$/;

export class MergeRefused extends Error {
  constructor(code) { super(code); this.name = 'MergeRefused'; this.code = code; }
}

export async function mergeVerifiedPullRequest({ owner, repoName, number, headCommitSha, baseCommitSha }, { githubToken, fetchFn = fetch } = {}) {
  if (!NAME.test(owner || '') || !NAME.test(repoName || '') || !Number.isSafeInteger(number) || number < 1
      || !SHA.test(headCommitSha || '') || !SHA.test(baseCommitSha || '') || typeof githubToken !== 'string' || !githubToken) {
    throw new MergeRefused('merge_blocked');
  }
  const root = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repoName);
  const headers = { authorization: 'Bearer ' + githubToken, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own' };
  const main = await fetchFn(root + '/branches/main', { method: 'GET', redirect: 'manual', headers });
  if (main.status === 401 || main.status === 403 || main.status === 404) throw new MergeRefused('credentials_revoked');
  const mainSha = main.ok ? (await main.json())?.commit?.sha : null;
  if (typeof mainSha !== 'string' || mainSha.toLowerCase() !== baseCommitSha.toLowerCase()) throw new MergeRefused('stale_base');
  const response = await fetchFn(root + '/pulls/' + number + '/merge', {
    method: 'PUT', redirect: 'manual', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sha: headCommitSha.toLowerCase(), merge_method: 'squash', commit_title: 'Publish approved website change (#' + number + ')' })
  });
  if (response.status === 401 || response.status === 404) throw new MergeRefused('credentials_revoked');
  // 403 (no merge rights / blocked by a rule), 405 (not mergeable), 409 (head moved), 422: leave the PR open.
  if (!response.ok) throw new MergeRefused('merge_blocked');
  const body = await response.json().catch(() => null);
  if (body?.merged !== true || !SHA.test(body.sha || '')) throw new MergeRefused('merge_blocked');
  return { merged: true, mergedCommitSha: body.sha.toLowerCase() };
}
