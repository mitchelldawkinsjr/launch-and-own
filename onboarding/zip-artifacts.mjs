import { sha256, sha256Bytes } from './crypto.mjs';
import { isSitePath, MAX_FILE_BYTES, MAX_SITE_BYTES, MAX_SITE_FILES, WebsiteZipError } from './website-zip.mjs';

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maxManifestBytes = 64 * 1024;
const missing = () => new WebsiteZipError('The upload expired or could not be read. Return to setup to upload it again.');
const damaged = () => new WebsiteZipError('The stored website no longer matches the reviewed upload.');
const manifestDigest = files => sha256(JSON.stringify([1, files]));

export function isZipArtifact(artifact) {
  return !!artifact && typeof artifact.id === 'string' && idPattern.test(artifact.id)
    && typeof artifact.digest === 'string' && hashPattern.test(artifact.digest)
    && Number.isSafeInteger(artifact.fileCount) && artifact.fileCount > 0 && artifact.fileCount <= MAX_SITE_FILES
    && Number.isSafeInteger(artifact.totalBytes) && artifact.totalBytes > 0 && artifact.totalBytes <= MAX_SITE_BYTES;
}

function objectKey(artifact, stage, part) {
  if (!isZipArtifact(artifact) || (stage !== 'draft' && stage !== 'approved')) throw damaged();
  return `website-zip/${stage}/${artifact.id}/${part}`;
}

async function putArtifact(bucket, artifact, stage, files, bytes) {
  await bucket.put(objectKey(artifact, stage, 'files'), bytes);
  // Writing the manifest last makes partial uploads invisible to readers.
  await bucket.put(objectKey(artifact, stage, 'manifest'), JSON.stringify(files));
}

export async function stageZip(bucket, id, files) {
  let offset = 0;
  const manifest = [];
  const bytes = new Uint8Array(files.reduce((size, file) => size + file.bytes.byteLength, 0));
  for (const file of files) {
    const size = file.bytes.byteLength;
    bytes.set(file.bytes, offset);
    manifest.push({ path: file.path, offset, size, hash: await sha256Bytes(file.bytes) });
    offset += size;
  }
  const artifact = { id, digest: await manifestDigest(manifest), fileCount: files.length, totalBytes: offset };
  await putArtifact(bucket, artifact, 'draft', manifest, bytes);
  return artifact;
}

export async function readZipManifest(bucket, artifact, stage) {
  if (!bucket) throw missing();
  const object = await bucket.get(objectKey(artifact, stage, 'manifest'));
  if (!object) throw missing();
  if (object.size > maxManifestBytes) throw damaged();
  let files;
  try { files = await object.json(); } catch { throw damaged(); }
  if (!Array.isArray(files) || files.length !== artifact.fileCount) throw damaged();
  let offset = 0;
  let previous = '';
  for (const file of files) {
    if (!file || !isSitePath(file.path) || file.path <= previous || file.offset !== offset
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES
        || typeof file.hash !== 'string' || !hashPattern.test(file.hash)) throw damaged();
    offset += file.size;
    previous = file.path;
  }
  if (offset !== artifact.totalBytes || !files.some(file => file.path === 'index.html' && file.size > 0)
      || await manifestDigest(files) !== artifact.digest) throw damaged();
  return files;
}

async function readFilesObject(bucket, artifact, stage, range) {
  const options = range ? { range: { offset: range.offset, length: range.size } } : undefined;
  const object = await bucket.get(objectKey(artifact, stage, 'files'), options);
  if (!object) throw missing();
  if (object.size !== artifact.totalBytes) throw damaged();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== (range?.size ?? object.size)) throw damaged();
  return bytes;
}

export async function readZipFile(bucket, artifact, stage, file) {
  const bytes = file.size ? await readFilesObject(bucket, artifact, stage, file) : new Uint8Array();
  if (await sha256Bytes(bytes) !== file.hash) throw damaged();
  return bytes;
}

async function readZip(bucket, artifact, stage) {
  const manifest = await readZipManifest(bucket, artifact, stage);
  const bytes = await readFilesObject(bucket, artifact, stage);
  const files = [];
  for (const file of manifest) {
    const contents = bytes.subarray(file.offset, file.offset + file.size);
    if (await sha256Bytes(contents) !== file.hash) throw damaged();
    files.push({ path: file.path, bytes: contents });
  }
  return { manifest, bytes, files };
}

export async function retainZip(bucket, artifact) {
  const key = objectKey(artifact, 'approved', 'manifest');
  if (await bucket.head(key)) {
    await readZip(bucket, artifact, 'approved');
    return;
  }
  const { manifest, bytes } = await readZip(bucket, artifact, 'draft');
  await putArtifact(bucket, artifact, 'approved', manifest, bytes);
}

export async function loadApprovedZip(bucket, artifact) {
  return (await readZip(bucket, artifact, 'approved')).files;
}
