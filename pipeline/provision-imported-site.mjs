import { createHash } from 'node:crypto';
import { ProviderRequestError } from './provider-errors.mjs';

const shaPattern = /^[a-f0-9]{40}$/;
const readBranch = `query WebsiteImportBranch($repo: ID!, $ref: String!) {
  node(id: $repo) {
    ... on Repository {
      name isPrivate owner { login }
      ref(qualifiedName: $ref) { id target { ... on Commit { oid tree { oid } } } }
    }
  }
}`;
const createCommit = `mutation CommitWebsiteImport($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid tree { oid } } }
}`;

async function githubGraphql(api, query, variables) {
  const result = await api.github('/graphql', { method: 'POST', body: { query, variables } });
  if (result?.errors?.length || !result?.data) {
    const forbidden = result?.errors?.some(error => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.type));
    throw new ProviderRequestError(forbidden ? new Response(null, { status: 403 }) : undefined);
  }
  return result.data;
}

function approvedTree(files) {
  const expected = new Map();
  for (const { path, bytes } of files) {
    const fullPath = 'public/' + path;
    const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    expected.set(fullPath, { type: 'blob', mode: '100644', sha: blobSha });
    for (let slash = fullPath.indexOf('/'); slash !== -1; slash = fullPath.indexOf('/', slash + 1)) {
      expected.set(fullPath.slice(0, slash), { type: 'tree', mode: '040000' });
    }
  }
  return expected;
}

async function inspectTree(api, repoPath, treeSha, expected) {
  if (!shaPattern.test(treeSha)) throw Error('GitHub did not return a source tree');
  const tree = await api.github(`${repoPath}/git/trees/${treeSha}?recursive=1`);
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw Error('GitHub did not return the full source tree');
  const entries = new Map(tree.tree.map(entry => [entry.path, entry]));
  const readme = entries.get('README.md');
  if (entries.size !== tree.tree.length || readme?.type !== 'blob' || readme.mode !== '100644') {
    throw Error('Repository differs from the approved starter repository');
  }
  entries.delete('README.md');
  if (entries.size === 0) return 'starter';
  if (entries.size === expected.size && Array.from(expected).every(([path, wanted]) => {
    const entry = entries.get(path);
    return entry?.mode === wanted.mode && entry.type === wanted.type && (!wanted.sha || entry.sha === wanted.sha);
  })) return 'approved';
  throw Error('Repository contains files outside the approved import');
}

export async function pinImportedCommit(api, { repoPath, repository, branch, approved, journal }) {
  if (!repository.node_id) throw Error('GitHub did not return an immutable repository identity');
  const { node } = await githubGraphql(api, readBranch, { repo: repository.node_id, ref: `refs/heads/${branch}` });
  const ref = node?.ref;
  const head = ref?.target;
  if (!ref?.id || !shaPattern.test(head?.oid) || node.name !== repository.name || node.isPrivate !== true
      || node.owner?.login?.toLowerCase() !== repository.owner.login.toLowerCase()) {
    throw Error('GitHub branch differs from the approved target');
  }
  if (approved.checkpoint && head.oid !== approved.checkpoint.headCommitSha) {
    throw Error('The default branch moved after the launch revision was recorded');
  }
  const expected = approvedTree(approved.files);
  const state = await inspectTree(api, repoPath, head.tree?.oid, expected);
  let sha = head.oid;
  if (state === 'starter') {
    if (approved.checkpoint) throw Error('The approved import is missing from the recorded commit');
    const additions = approved.files.map(({ path, bytes }) => ({
      path: 'public/' + path, contents: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
    }));
    await approved.assertCloudflareAccess();
    // GitHub only updates this exact ref if it still points at the inspected parent.
    const { createCommitOnBranch } = await githubGraphql(api, createCommit, { input: {
      branch: { id: ref.id }, expectedHeadOid: head.oid,
      message: { headline: 'Import approved Launch & Own website' }, fileChanges: { additions }
    } });
    const commit = createCommitOnBranch?.commit;
    if (!shaPattern.test(commit?.oid)) throw new ProviderRequestError();
    if (await inspectTree(api, repoPath, commit.tree?.oid, expected) !== 'approved') {
      throw Error('GitHub did not record the exact approved import');
    }
    sha = commit.oid;
  }
  await approved.saveCheckpoint({ repositoryId: repository.id, branch, headCommitSha: sha });
  journal.push({ resource: 'website-import', name: 'public/', action: state === 'starter' ? 'created' : 'preserved' });
  return sha;
}
