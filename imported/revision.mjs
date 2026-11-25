import { base64Decode, gitBlobSha } from './bytes.mjs';
import { ImportedEditError } from './errors.mjs';
import { isManagedRepositoryDescription } from '../pipeline/managed-site-repository.mjs';
import { MAX_FILE_BYTES, MAX_FILES, MAX_SITE_BYTES, structuralPath } from './intelligence.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const NAME = /^[A-Za-z0-9_.-]+$/;

function githubClient(token, fetchFn) {
  if (typeof token !== 'string' || !token) throw new ImportedEditError('github-access-required');
  return async (path, { allow404 = false } = {}) => {
    const response = await fetchFn('https://api.github.com' + path, {
      method: 'GET', redirect: 'manual',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'launch-and-own'
      }
    });
    if (allow404 && response.status === 404) return null;
    if (response.status === 401 || response.status === 403 || response.status === 404) throw new ImportedEditError('credentials_revoked');
    if (!response.ok) throw new ImportedEditError('github-read-failed');
    try { return await response.json(); } catch { throw new ImportedEditError('github-read-failed'); }
  };
}

export async function readCurrentRevision(input) {
  const allowed = new Set(['owner', 'repo', 'token', 'fetchFn']);
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowed.has(key))) {
    throw new ImportedEditError('revision-must-be-read');
  }
  const { owner, repo, token, fetchFn = fetch } = input;
  if (!NAME.test(owner || '') || !NAME.test(repo || '') || !repo.startsWith('esp-')) throw new ImportedEditError('repository-mismatch');
  const gh = githubClient(token, fetchFn);
  const root = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  const user = await gh('/user');
  const repository = await gh(root);
  const slug = repo.slice(4);
  const owned = Number.isSafeInteger(user?.id) && user.id >= 1
    && user.login?.toLowerCase() === owner.toLowerCase()
    && Number.isSafeInteger(repository?.id) && repository.id >= 1
    && repository.private === true && repository.default_branch === 'main'
    && repository.name === repo && repository.owner?.id === user.id
    && repository.owner?.login?.toLowerCase() === owner.toLowerCase()
    && isManagedRepositoryDescription(repository.description, slug);
  if (!owned) throw new ImportedEditError('repository-mismatch');
  const branch = await gh(root + '/branches/main');
  const commitSha = branch?.commit?.sha;
  if (typeof commitSha !== 'string' || !SHA.test(commitSha)) throw new ImportedEditError('revision-unreadable');
  const commit = await gh(root + '/git/commits/' + commitSha);
  const treeSha = commit?.tree?.sha;
  if (commit?.sha !== commitSha || typeof treeSha !== 'string' || !SHA.test(treeSha)) throw new ImportedEditError('revision-unreadable');
  const tree = await gh(root + '/git/trees/' + treeSha + '?recursive=1');
  if (tree?.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length === 0 || tree.tree.length > 4096) {
    throw new ImportedEditError('revision-unreadable');
  }
  const files = [];
  let total = 0;
  for (const entry of tree.tree) {
    if (!entry || typeof entry.path !== 'string' || !entry.path.startsWith('public/')) continue;
    if (entry.type !== 'blob') continue;
    if (entry.mode !== '100644' || typeof entry.sha !== 'string' || !SHA.test(entry.sha)) throw new ImportedEditError('unsupported-tree');
    const path = entry.path.slice('public/'.length);
    if (!structuralPath(path)) throw new ImportedEditError('unsupported-tree');
    const blob = await gh(root + '/git/blobs/' + entry.sha);
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || blob.sha !== entry.sha) throw new ImportedEditError('revision-unreadable');
    const bytes = base64Decode(blob.content);
    if (bytes.byteLength > MAX_FILE_BYTES || await gitBlobSha(bytes) !== entry.sha.toLowerCase()) {
      throw new ImportedEditError('revision-unreadable');
    }
    total += bytes.byteLength;
    files.push({ path, gitPath: entry.path, bytes, blobSha: entry.sha.toLowerCase() });
  }
  if (files.length === 0) throw new ImportedEditError('revision-unreadable');
  if (files.length > MAX_FILES || total > MAX_SITE_BYTES) throw new ImportedEditError('site-too-large');
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    ownerLogin: owner,
    githubUserId: user.id,
    repositoryId: repository.id,
    repository: owner + '/' + repo,
    commitSha: commitSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
    files
  };
}
