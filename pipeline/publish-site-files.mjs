// Commits the owner-approved new files (site-files-proposal.mjs) to a branch, opens a PR and, on
// "Approve and publish", merges it. The proposal is rebuilt from current main and must match the approved
// digest exactly; the head commit must add exactly those files and nothing else.
import { base64Encode, gitBlobSha } from '../imported/bytes.mjs';
import { isManagedRepositoryDescription } from './managed-site-repository.mjs';
import { MergeRefused, mergeVerifiedPullRequest } from './merge-approved-pr.mjs';

const SHA = /^[a-f0-9]{40}$/i;
export class SiteFilesRefused extends Error {
  constructor(code) { super(code); this.name = 'SiteFilesRefused'; this.code = code; }
}
const refuse = code => { throw new SiteFilesRefused(code); };

function client(token, fetchFn) {
  if (typeof token !== 'string' || !token) refuse('github_access_required');
  return async (path, {method = 'GET', body} = {}) => {
    const response = await fetchFn('https://api.github.com' + path, {
      method, redirect: 'manual',
      headers: {authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own',
        ...(body === undefined ? {} : {'content-type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) refuse('credentials_revoked');
    if (!response.ok) refuse('github_write_failed');
    try { return await response.json(); } catch { refuse('github_write_failed'); }
  };
}

/** Read-only: the managed repo's current main and its file list, then the proposal for it. */
export async function readSiteFiles({owner, repoName, repositoryId, propose}, {githubToken, fetchFn = fetch} = {}) {
  const gh = client(githubToken, fetchFn);
  const root = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repoName);
  const repo = await gh(root);
  if (repo?.id !== repositoryId || repo?.private !== true || repo?.name !== repoName || repo?.default_branch !== 'main' ||
      repo?.owner?.login?.toLowerCase() !== String(owner).toLowerCase() ||
      !isManagedRepositoryDescription(repo?.description, repoName.slice(4))) refuse('repository_mismatch');
  const baseSha = String((await gh(root + '/branches/main'))?.commit?.sha || '').toLowerCase();
  if (!SHA.test(baseSha)) refuse('tree_unreadable');
  const treeSha = (await gh(root + '/git/commits/' + baseSha))?.tree?.sha;
  if (!SHA.test(treeSha || '')) refuse('tree_unreadable');
  const tree = await gh(root + '/git/trees/' + treeSha + '?recursive=1');
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) refuse('tree_unreadable');
  const paths = tree.tree.filter(e => e?.type === 'blob').map(e => e.path);
  return {gh, root, baseSha, treeSha, proposal: await propose(paths)};
}

export async function publishSiteFiles({owner, repoName, repositoryId, propose, approvedDigest, merge}, {githubToken, fetchFn = fetch} = {}) {
  const {gh, root, baseSha, treeSha, proposal} = await readSiteFiles({owner, repoName, repositoryId, propose}, {githubToken, fetchFn});
  if (!proposal?.ok) refuse(proposal?.reason || 'proposal_refused');
  if (proposal.digest !== approvedDigest) refuse('approval_digest_mismatch');
  const blobs = [];
  for (const file of proposal.files) {
    const bytes = new TextEncoder().encode(file.content);
    const created = await gh(root + '/git/blobs', {method: 'POST', body: {content: base64Encode(bytes), encoding: 'base64'}});
    if (created?.sha !== await gitBlobSha(bytes)) refuse('blob_mismatch');
    blobs.push({path: file.path, mode: '100644', type: 'blob', sha: created.sha});
  }
  const nextTree = await gh(root + '/git/trees', {method: 'POST', body: {base_tree: treeSha, tree: blobs}});
  if (!SHA.test(nextTree?.sha || '')) refuse('tree_mismatch');
  const commit = await gh(root + '/git/commits', {method: 'POST',
    body: {message: 'Add approved site files: ' + blobs.map(b => b.path.slice(7)).join(', '), tree: nextTree.sha, parents: [baseSha]}});
  const headSha = String(commit?.sha || '').toLowerCase();
  if (!SHA.test(headSha)) refuse('commit_mismatch');
  const branch = 'launch-and-own/site-files-' + approvedDigest.slice(0, 20);
  await gh(root + '/git/refs', {method: 'POST', body: {ref: 'refs/heads/' + branch, sha: headSha}});
  const head = await gh(root + '/commits/' + headSha);
  if (head?.parents?.length !== 1 || head.parents[0]?.sha !== baseSha || !Array.isArray(head.files) ||
      head.files.length !== blobs.length ||
      !head.files.every(f => f.status === 'added' && blobs.some(b => b.path === f.filename && b.sha === f.sha)))
    refuse('unrelated_change');
  const pull = await gh(root + '/pulls', {method: 'POST', body: {title: 'Add approved site files', head: branch, base: 'main',
    body: 'Adds only new files the site owner reviewed and approved in Launch & Own. No existing file is changed.'}});
  if (!Number.isSafeInteger(pull?.number) || String(pull?.head?.sha || '').toLowerCase() !== headSha) refuse('pull_request_unreadable');
  let merged = false, mergeNote = null;
  if (merge) {
    try { merged = (await mergeVerifiedPullRequest({owner, repoName, number: pull.number, headCommitSha: headSha, baseCommitSha: baseSha},
      {githubToken, fetchFn})).merged; }
    catch (error) { if (!(error instanceof MergeRefused)) throw error; mergeNote = error.code; }
  }
  return {number: pull.number, url: pull.html_url, merged, mergeNote, files: proposal.files.map(f => f.path)};
}
