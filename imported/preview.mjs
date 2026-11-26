import { sha256Bytes, sha256Text, stableJson } from './bytes.mjs';
import { ImportedEditError } from './errors.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const SECRET_KEY = /token|authorization|cookie|secret|password|^credentials?$/i;

export async function artifactDigest(files) {
  const ordered = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  let offset = 0;
  const manifest = [];
  for (const file of ordered) {
    const size = file.bytes.byteLength;
    manifest.push({ path: file.path, offset, size, hash: await sha256Bytes(file.bytes) });
    offset += size;
  }
  return sha256Text(JSON.stringify([1, manifest]));
}

export async function treeDigest(files, baseCommitSha) {
  const rows = [];
  const ordered = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const file of ordered) rows.push([file.path, await sha256Bytes(file.bytes)]);
  return sha256Text(stableJson([baseCommitSha.toLowerCase(), rows]));
}

export async function isolatePreview({ files, baseCommitSha, githubUserId, repositoryId, ownerLogin }) {
  if (!Array.isArray(files) || typeof baseCommitSha !== 'string' || !SHA.test(baseCommitSha)) throw new ImportedEditError('invalid-preview');
  if (!Number.isSafeInteger(githubUserId) || githubUserId < 1 || !Number.isSafeInteger(repositoryId) || repositoryId < 1) {
    throw new ImportedEditError('invalid-preview');
  }
  if (typeof ownerLogin !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(ownerLogin)) throw new ImportedEditError('invalid-preview');
  return {
    origin: 'isolated-preview',
    credentialsIncluded: false,
    baseCommitSha: baseCommitSha.toLowerCase(),
    githubUserId,
    repositoryId,
    ownerLogin,
    digest: await treeDigest(files, baseCommitSha),
    files: files.map(file => ({ path: file.path, bytes: file.bytes }))
  };
}

export function previewCredentialKeys(value) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || node instanceof Uint8Array) return;
    for (const key of Object.keys(node)) {
      if (SECRET_KEY.test(key)) found.push(key);
      visit(node[key]);
    }
  };
  visit(value);
  return found;
}

// Script-free site preview: same resource policy as onboarding/zip-preview-worker bundled mode.
export const SCRIPT_FREE_SITE_CSP =
  "sandbox allow-same-origin; default-src 'none'; script-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'none'; base-uri 'self'";

export function scriptFreePreviewHeaders({ frameAncestors = "'none'" } = {}) {
  return {
    'cache-control': 'private, no-store',
    'content-security-policy': SCRIPT_FREE_SITE_CSP + '; frame-ancestors ' + frameAncestors,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow'
  };
}

const TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['svg', 'image/svg+xml'],
  ['txt', 'text/plain; charset=utf-8']
]);

export function previewResponse(preview, pathname) {
  const headers = scriptFreePreviewHeaders();
  if (!preview || preview.credentialsIncluded !== false || typeof pathname !== 'string' || pathname.includes('..') || pathname.includes('\\')) {
    return { status: 404, headers, body: null };
  }
  const path = pathname.replace(/^\/+/, '');
  const file = preview.files.find(item => item.path === path);
  if (!file) return { status: 404, headers, body: null };
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  return {
    status: 200,
    headers: { ...headers, 'content-type': TYPES.get(extension) || 'application/octet-stream' },
    body: file.bytes
  };
}
