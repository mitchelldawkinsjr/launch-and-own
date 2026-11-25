import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { extractWebsiteZip } from '../../../onboarding/website-zip.mjs';
const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('research/provenance.json', root)));
const importer = await readFile(new URL('../../../onboarding/website-zip.mjs', import.meta.url));
const importerBlobSha = createHash('sha1').update('blob '+importer.length+'\0').update(importer).digest('hex');
async function walk(url, prefix = '') {
  const out = [];
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) out.push(...await walk(new URL(entry.name+'/', url), name+'/'));
    else { assert(entry.isFile()); out.push([name, await readFile(new URL(entry.name,url))]); }
  }
  return out.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
}
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [path, bytes] of files) {
    const name = Buffer.from(path), crc = crc32(bytes);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20,4); l.writeUInt32LE(crc,14); l.writeUInt32LE(bytes.length,18); l.writeUInt32LE(bytes.length,22); l.writeUInt16LE(name.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt32LE(crc,16); c.writeUInt32LE(bytes.length,20); c.writeUInt32LE(bytes.length,24); c.writeUInt16LE(name.length,28); c.writeUInt32LE(offset,42);
    local.push(l,name,bytes); central.push(c,name); offset += l.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
const results = [];
for (const f of metadata.fixtures) {
  const dir = new URL(f.name+'/',root), files = await walk(new URL('public/',dir));
  const expected = JSON.parse(await readFile(new URL('expected-inventory.json',dir)));
  assert.equal(expected.classification,f.expectedClassification);
  assert.equal(expected.importable,f.expectedArchive === 'accepted');
  assert.equal(expected.serveReady,f.expectedServeReady); // metadata agreement only; not a classifier test
  assert.deepEqual(expected.reasons,[...new Set(expected.reasons)].sort());
  assert.deepEqual(expected.files.map(x=>[x.path,x.bytes]),files.map(([p,b])=>['public/'+p,b.length]));
  const archive = zip(files);
  let imported, error;
  try { imported = await extractWebsiteZip(archive); } catch (e) { error = e.message; }
  if (f.expectedArchive === 'accepted') {
    assert.equal(error,undefined); assert.deepEqual(imported.map(x=>[x.path,Buffer.from(x.bytes)]),files);
  } else { assert.equal(error,f.expectedError); }
  assert.equal(expected.importable,!error);
  results.push({name:f.name,observed:error?'rejected':'accepted',error:error??null,zipSha256:createHash('sha256').update(archive).digest('hex')});
}
console.log(JSON.stringify({node:process.version,importerBlobSha,results},null,2));
