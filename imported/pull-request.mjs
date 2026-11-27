import { base64Decode, base64Encode, gitBlobSha, sameBytes, sha256Bytes, sha256Text } from './bytes.mjs';
import { approvalDigest } from './approval.mjs';
import { ImportedEditError } from './errors.mjs';
import { isManagedRepositoryDescription } from '../pipeline/managed-site-repository.mjs';
import { hasApprovedUpdateHead } from '../pipeline/propose-site-update.mjs';

const SHA = /^[a-f0-9]{40}$/i;

function client(token, fetchFn) {
  if (typeof token !== 'string' || !token) throw new ImportedEditError('github-access-required');
  return async (path, { method = 'GET', body, allow404 = false } = {}) => {
    const response = await fetchFn('https://api.github.com' + path, {
      method, redirect: 'manual',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'launch-and-own',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (allow404 && response.status === 404) return null;
    if (response.status === 401 || response.status === 403 || response.status === 404) throw new ImportedEditError('credentials_revoked');
    if (!response.ok) throw new ImportedEditError('github-write-failed');
    try { return await response.json(); } catch { throw new ImportedEditError('github-write-failed'); }
  };
}

/** Repository and owner checks. Hosted (default): the GitHub user from /user owns the managed repo.
 *  installation (customer-owned assistant): an installation token cannot call /user; the receipt's Access owner
 *  approved, and the repo must be the exact pinned managed repo. Returns the repo and its owner's numeric id. */
async function verifyTarget(gh, receipt, root, owner, repoName, installation) {
  const user = installation ? null : await gh('/user');
  const repo = await gh(root);
  const slug = repoName.slice(4);
  const ownerOk = installation
    ? receipt.owner?.provider === 'cloudflare_access' && typeof receipt.owner.id === 'string' && receipt.owner.id.length > 0
    : receipt.owner?.provider === 'github' && String(user?.id) === receipt.owner.id && user?.login?.toLowerCase() === owner.toLowerCase();
  const ownerId = installation ? repo?.owner?.id : user?.id;
  if (!ownerOk || !Number.isSafeInteger(ownerId) || repo?.id !== receipt.repositoryId || repo?.private !== true || repo?.name !== repoName
      || repo?.owner?.id !== ownerId || repo?.owner?.login?.toLowerCase() !== owner.toLowerCase() || !isManagedRepositoryDescription(repo?.description, slug)) {
    throw new ImportedEditError('repository-mismatch');
  }
  return { repo, ownerId };
}

async function changedFiles(baseFiles, nextFiles, approved) {
  if (Array.isArray(approved) && approved.some(row => row?.added === true)) return addedChangedFiles(baseFiles, nextFiles, approved);
  if (!Array.isArray(baseFiles) || !Array.isArray(nextFiles) || baseFiles.length !== nextFiles.length) {
    throw new ImportedEditError('file-set-mismatch');
  }
  const changed = [];
  for (let index = 0; index < baseFiles.length; index++) {
    if (baseFiles[index].path !== nextFiles[index].path) throw new ImportedEditError('file-set-mismatch');
    if (sameBytes(baseFiles[index].bytes, nextFiles[index].bytes)) continue;
    changed.push({ path: baseFiles[index].path, before: baseFiles[index].bytes, after: nextFiles[index].bytes });
  }
  changed.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (changed.length !== approved.length) throw new ImportedEditError('approval-digest-mismatch');
  for (let index = 0; index < changed.length; index++) {
    if ('public/' + changed[index].path !== approved[index].path
        || await gitBlobSha(changed[index].before) !== approved[index].beforeBlobSha
        || await sha256Bytes(changed[index].after) !== approved[index].afterSha256) {
      throw new ImportedEditError('approval-digest-mismatch');
    }
  }
  return changed;
}

async function addedChangedFiles(baseFiles, nextFiles, approved) {
  if (!Array.isArray(baseFiles) || !Array.isArray(nextFiles)) throw new ImportedEditError('file-set-mismatch');
  const baseBy = new Map(baseFiles.map(file => [file.path, file]));
  const nextBy = new Map(nextFiles.map(file => [file.path, file]));
  if (baseBy.size !== baseFiles.length || nextBy.size !== nextFiles.length) throw new ImportedEditError('file-set-mismatch');
  for (const file of baseFiles) if (!nextBy.has(file.path)) throw new ImportedEditError('file-set-mismatch');
  const changed = [];
  for (const row of approved) {
    const relative = row.path.slice('public/'.length);
    const after = nextBy.get(relative);
    if (!after || await sha256Bytes(after.bytes) !== row.afterSha256) throw new ImportedEditError('approval-digest-mismatch');
    if (row.added === true) {
      if (baseBy.has(relative)) throw new ImportedEditError('file-set-mismatch');
      changed.push({ path: relative, added: true, after: after.bytes });
    } else {
      const before = baseBy.get(relative);
      if (!before || await gitBlobSha(before.bytes) !== row.beforeBlobSha) throw new ImportedEditError('approval-digest-mismatch');
      changed.push({ path: relative, before: before.bytes, after: after.bytes });
    }
  }
  changed.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (changed.length !== approved.length) throw new ImportedEditError('approval-digest-mismatch');
  for (const file of baseFiles) {
    if (!changed.some(item => item.path === file.path) && !sameBytes(file.bytes, nextBy.get(file.path).bytes)) {
      throw new ImportedEditError('unrelated_change');
    }
  }
  for (const file of nextFiles) {
    if (!baseBy.has(file.path) && !changed.some(item => item.added && item.path === file.path)) {
      throw new ImportedEditError('unrelated_change');
    }
  }
  return changed;
}

async function verifyHeadWithAdditions(gh, root, headSha, baseSha, baseEntries, changed) {
  const commit = await gh(root + '/commits/' + headSha);
  const treeSha = commit?.commit?.tree?.sha;
  if (commit?.sha !== headSha || !Array.isArray(commit.parents) || commit.parents.length !== 1 || commit.parents[0]?.sha !== baseSha
      || typeof treeSha !== 'string' || !SHA.test(treeSha)) throw new ImportedEditError('commit-mismatch');
  const headTree = await gh(root + '/git/trees/' + treeSha + '?recursive=1');
  if (headTree?.truncated !== false || !Array.isArray(headTree.tree)) throw new ImportedEditError('commit-mismatch');
  const headByPath = new Map(headTree.tree.map(entry => [entry.path, entry]));
  const addedPaths = new Set(changed.filter(file => file.added).map(file => 'public/' + file.path));
  const extraDirs = new Set();
  for (const path of addedPaths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join('/');
      if (!baseEntries.has(dir)) extraDirs.add(dir);
    }
  }
  for (const [path, after] of headByPath) {
    if (baseEntries.has(path)) continue;
    if (addedPaths.has(path)) {
      if (after.type !== 'blob' || after.mode !== '100644') throw new ImportedEditError('unrelated_change');
      continue;
    }
    if (extraDirs.has(path) && after.type === 'tree') continue;
    throw new ImportedEditError('unrelated_change');
  }
  for (const path of addedPaths) if (!headByPath.has(path)) throw new ImportedEditError('commit-mismatch');
  const changedByPath = new Map(changed.map(file => ['public/' + file.path, file]));
  for (const [path, before] of baseEntries) {
    const after = headByPath.get(path);
    if (!after || after.type !== before.type || after.mode !== before.mode) throw new ImportedEditError('unrelated_change');
    const edit = changedByPath.get(path);
    if (before.type !== 'blob') continue;
    const expected = edit ? await gitBlobSha(edit.after) : String(before.sha || '').toLowerCase();
    if (String(after.sha || '').toLowerCase() !== expected) throw new ImportedEditError(edit ? 'commit-mismatch' : 'unrelated_change');
  }
  for (const path of addedPaths) {
    const edit = changedByPath.get(path);
    if (String(headByPath.get(path).sha || '').toLowerCase() !== await gitBlobSha(edit.after)) throw new ImportedEditError('commit-mismatch');
  }
  if (!Array.isArray(commit.files) || commit.files.length !== changed.length) throw new ImportedEditError('unrelated_change');
  for (const file of commit.files) {
    const edit = changed.find(item => 'public/' + item.path === file.filename);
    const status = edit?.added ? 'added' : 'modified';
    if (!edit || file.status !== status || String(file.sha || '').toLowerCase() !== await gitBlobSha(edit.after)) {
      throw new ImportedEditError('unrelated_change');
    }
  }
}

async function verifyHead(gh, root, headSha, baseSha, baseEntries, changed) {
  if (changed.some(file => file.added)) return verifyHeadWithAdditions(gh, root, headSha, baseSha, baseEntries, changed);
  const commit = await gh(root + '/commits/' + headSha);
  const treeSha = commit?.commit?.tree?.sha;
  if (commit?.sha !== headSha || !Array.isArray(commit.parents) || commit.parents.length !== 1 || commit.parents[0]?.sha !== baseSha
      || typeof treeSha !== 'string' || !SHA.test(treeSha)) throw new ImportedEditError('commit-mismatch');
  const headTree = await gh(root + '/git/trees/' + treeSha + '?recursive=1');
  if (headTree?.truncated !== false || !Array.isArray(headTree.tree)) throw new ImportedEditError('commit-mismatch');
  const headByPath = new Map(headTree.tree.map(entry => [entry.path, entry]));
  if (headByPath.size !== baseEntries.size) throw new ImportedEditError('unrelated_change');
  const changedByPath = new Map(changed.map(file => ['public/' + file.path, file]));
  for (const [path, before] of baseEntries) {
    const after = headByPath.get(path);
    if (!after || after.type !== before.type || after.mode !== before.mode) throw new ImportedEditError('unrelated_change');
    const edit = changedByPath.get(path);
    if (before.type !== 'blob') continue;
    const expected = edit ? await gitBlobSha(edit.after) : String(before.sha || '').toLowerCase();
    if (String(after.sha || '').toLowerCase() !== expected) throw new ImportedEditError(edit ? 'commit-mismatch' : 'unrelated_change');
  }
  if (!Array.isArray(commit.files) || commit.files.length !== changed.length) throw new ImportedEditError('unrelated_change');
  for (const file of commit.files) {
    const edit = changed.find(item => 'public/' + item.path === file.filename);
    if (!edit || file.status !== 'modified' || String(file.sha || '').toLowerCase() !== await gitBlobSha(edit.after)) {
      throw new ImportedEditError('unrelated_change');
    }
  }
}

export async function readImportedPullRequest(receipt, { githubToken, fetchFn = fetch, number, headCommitSha, installation = false } = {}) {
  if (!Number.isSafeInteger(number) || number < 1 || typeof headCommitSha !== 'string' || !SHA.test(headCommitSha)) {
    throw new ImportedEditError('pull-request-unreadable');
  }
  const gh = client(githubToken, fetchFn);
  const owner = receipt.ownerLogin;
  const repoName = receipt.repository.slice(owner.length + 1);
  const root = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repoName);
  const { repo } = await verifyTarget(gh, receipt, root, owner, repoName, installation);
  const branchName = 'launch-and-own/edit-' + (await sha256Text(receipt.baseCommitSha + ':' + receipt.artifactDigest)).slice(0, 20);
  const pull = await gh(root + '/pulls/' + number);
  const url = 'https://github.com/' + owner + '/' + repoName + '/pull/' + number;
  if (pull?.number !== number || pull?.html_url !== url || pull?.head?.ref !== branchName || pull?.base?.ref !== 'main'
      || String(pull?.base?.sha || '').toLowerCase() !== receipt.baseCommitSha || pull?.head?.repo?.id !== repo.id) {
    throw new ImportedEditError('pull-request-unreadable');
  }
  if (String(pull.head?.sha || '').toLowerCase() !== headCommitSha.toLowerCase()) {
    return { status: 'failed', pullRequest: url, live: false, merged: false };
  }
  if (pull.merged_at || pull.merged === true) {
    if (typeof pull.merge_commit_sha !== 'string' || !SHA.test(pull.merge_commit_sha)) throw new ImportedEditError('revision-unreadable');
    return { status: 'merged', pullRequest: url, mergedCommitSha: pull.merge_commit_sha.toLowerCase(), live: false, merged: true };
  }
  if (pull.state === 'closed') return { status: 'rejected', pullRequest: url, live: false, merged: false };
  if (pull.state !== 'open') throw new ImportedEditError('pull-request-unreadable');
  return { status: 'pr_open', pullRequest: url, live: false, merged: false };
}

export async function proposeImportedPullRequest(receipt, proposal, { githubToken, fetchFn = fetch, approvalStore, installation = false } = {}) {
  if (receipt?.explicitlyApproved !== true) throw new ImportedEditError('approval-required');
  if (!approvalStore || typeof approvalStore.claim !== 'function') throw new ImportedEditError('approval-required');
  if (await approvalDigest(receipt) !== receipt.digest) throw new ImportedEditError('approval-digest-mismatch');
  if (!Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= Math.floor(Date.now() / 1000)) throw new ImportedEditError('expired');
  const changed = await changedFiles(proposal?.baseFiles, proposal?.nextFiles, receipt.changed);
  let claim = await approvalStore.claim(receipt);
  const gh = client(githubToken, fetchFn);
  const owner = receipt.ownerLogin;
  const repoName = receipt.repository.slice(owner.length + 1);
  const root = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repoName);
  const { repo } = await verifyTarget(gh, receipt, root, owner, repoName, installation);
  if (repo.default_branch !== 'main') throw new ImportedEditError('repository-mismatch');
  const readMain = async () => {
    const branch = await gh(root + '/branches/main');
    const sha = branch?.commit?.sha;
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new ImportedEditError('stale_base');
    return sha.toLowerCase();
  };
  const baseSha = await readMain();
  if (baseSha !== receipt.baseCommitSha) throw new ImportedEditError('stale_base');
  const baseCommit = await gh(root + '/git/commits/' + baseSha);
  const baseTree = baseCommit?.tree?.sha;
  if (baseCommit?.sha !== baseSha || typeof baseTree !== 'string' || !SHA.test(baseTree)) throw new ImportedEditError('tree-unreadable');
  const tree = await gh(root + '/git/trees/' + baseTree + '?recursive=1');
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw new ImportedEditError('tree-unreadable');
  const baseEntries = new Map(tree.tree.map(entry => [entry.path, entry]));
  for (const file of changed) {
    if (file.added) continue;
    const entry = baseEntries.get('public/' + file.path);
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644') throw new ImportedEditError('base-content-mismatch');
    const blob = await gh(root + '/git/blobs/' + entry.sha);
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') throw new ImportedEditError('base-content-mismatch');
    const bytes = base64Decode(blob.content);
    if (blob.sha !== entry.sha || !sameBytes(bytes, file.before)) throw new ImportedEditError('base-content-mismatch');
  }
  const branchName = 'launch-and-own/edit-' + (await sha256Text(receipt.baseCommitSha + ':' + receipt.artifactDigest)).slice(0, 20);
  const refSuffix = branchName.split('/').map(encodeURIComponent).join('/');
  const existingRef = await gh(root + '/git/ref/heads/' + refSuffix, { allow404: true });
  let headSha = existingRef?.object?.sha;
  if (existingRef && (typeof headSha !== 'string' || !SHA.test(headSha))) throw new ImportedEditError('commit-mismatch');
  if (!claim.write && !existingRef) {
    // shortcut: same owner can finish the one commit after 60s if the first claim died before the branch existed
    if (typeof approvalStore.resume !== 'function' || !await approvalStore.resume(receipt)) throw new ImportedEditError('approval_consumed');
    claim = { write: true };
  }
  if (claim.write && (!existingRef || headSha === baseSha)) {
    if (await readMain() !== receipt.baseCommitSha) throw new ImportedEditError('stale_base');
    if (!existingRef) await gh(root + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + branchName, sha: baseSha } });
    const blobs = [];
    for (const file of changed) {
      const created = await gh(root + '/git/blobs', { method: 'POST', body: { content: base64Encode(file.after), encoding: 'base64' } });
      if (created?.sha !== await gitBlobSha(file.after)) throw new ImportedEditError('blob-mismatch');
      blobs.push({ path: 'public/' + file.path, mode: '100644', type: 'blob', sha: created.sha });
    }
    const nextTree = await gh(root + '/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: blobs } });
    if (typeof nextTree?.sha !== 'string' || !SHA.test(nextTree.sha)) throw new ImportedEditError('tree-mismatch');
    const nextCommit = await gh(root + '/git/commits', {
      method: 'POST',
      body: { message: 'Propose approved imported website edits', tree: nextTree.sha, parents: [baseSha] }
    });
    if (typeof nextCommit?.sha !== 'string' || !SHA.test(nextCommit.sha)) throw new ImportedEditError('commit-mismatch');
    headSha = nextCommit.sha;
    if (await readMain() !== receipt.baseCommitSha) throw new ImportedEditError('stale_base');
    await gh(root + '/git/refs/heads/' + refSuffix, { method: 'PATCH', body: { sha: headSha } });
  }
  await verifyHead(gh, root, headSha, baseSha, baseEntries, changed);
  const query = '?head=' + encodeURIComponent(owner + ':' + branchName) + '&base=main&state=all&per_page=20';
  const previous = await gh(root + '/pulls' + query);
  if (!Array.isArray(previous)) throw new ImportedEditError('pull-request-unreadable');
  const repositoryUrl = 'https://github.com/' + owner + '/' + repoName;
  const match = previous.find(item => item?.head?.ref === branchName && item?.base?.ref === 'main');
  if (match) {
    if (!hasApprovedUpdateHead(match, { repositoryId: repo.id, headCommitSha: headSha })
        || match.state !== 'open' || match.base?.sha !== baseSha
        || match.html_url !== repositoryUrl + '/pull/' + match.number) {
      throw new ImportedEditError('pull-request-needs-review');
    }
    return result(repositoryUrl, match, branchName, baseSha, headSha, receipt.artifactDigest, true);
  }
  if (previous.length > 0) throw new ImportedEditError('pull-request-needs-review');
  const summary = [
    'This pull request stages the imported-site edits the owner approved.',
    'Reviewed main commit: ' + baseSha,
    'Approved artifact digest: ' + receipt.artifactDigest,
    'Changed files: ' + changed.map(file => 'public/' + file.path).join(', '),
    'The owner approved this exact change. If they chose Approve and publish, it is merged right after this pull request opens. Otherwise review the diff and merge it yourself. Opening this request does not merge or publish the site.'
  ].join('\n\n');
  const pull = await gh(root + '/pulls', {
    method: 'POST',
    body: { title: 'Update imported website (Launch & Own)', head: branchName, base: 'main', body: summary }
  });
  if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || pull.state !== 'open' || pull.head?.ref !== branchName || pull.head?.sha !== headSha
      || pull.base?.ref !== 'main' || pull.base?.sha !== baseSha || pull.head?.repo?.id !== repo.id
      || pull.html_url !== repositoryUrl + '/pull/' + pull.number) {
    throw new ImportedEditError('pull-request-unreadable');
  }
  return result(repositoryUrl, pull, branchName, baseSha, headSha, receipt.artifactDigest, false);
}

function result(repository, pull, branch, baseCommitSha, headCommitSha, artifactDigest, reused) {
  return {
    status: 'pr_open',
    live: false,
    merged: false,
    repository,
    pullRequest: pull.html_url,
    number: pull.number,
    branch,
    baseCommitSha,
    headCommitSha,
    artifactDigest,
    reused
  };
}
