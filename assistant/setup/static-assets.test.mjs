import test from 'node:test';
import assert from 'node:assert/strict';
import { assetManifest, uploadStaticAssets, ASSETS_BINDING } from './static-assets.mjs';
import { SITE_EDITOR_ASSETS } from '../../onboarding/site-editor-assets-source.mjs';

const b64 = s => Buffer.from(s).toString('base64');
const files = [
  { path: '/index.html', base64: b64('<!doctype html>'), contentType: 'text/html' },
  { path: '/js/editor.js', base64: b64('export {}'), contentType: 'text/javascript' }
];
const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });
const args = (fetchFn) => ({ accountId: 'a'.repeat(32), workerName: 'acme-assistant', cloudflareToken: 'tok', files, fetchFn });

test('manifest uses 32-hex hashes and decoded sizes, and rejects traversal', async () => {
  const { manifest } = await assetManifest(files);
  assert.match(manifest['/index.html'].hash, /^[0-9a-f]{32}$/);
  assert.equal(manifest['/index.html'].size, 15);
  await assert.rejects(assetManifest([{ path: '/../x.js', base64: '' }]), /assets_invalid/);
  await assert.rejects(assetManifest([{ path: 'x.js', base64: '' }]), /assets_invalid/);
});

test('uploads only requested buckets with the session JWT and returns the completion JWT', async () => {
  const { manifest } = await assetManifest(files);
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: init.body });
    if (url.endsWith('/assets-upload-session')) {
      assert.deepEqual(JSON.parse(init.body).manifest, manifest);
      return ok({ jwt: 'session', buckets: [[manifest['/js/editor.js'].hash]] });
    }
    assert.match(url, /\/workers\/assets\/upload\?base64=true$/);
    assert.deepEqual([...init.body.keys()], [manifest['/js/editor.js'].hash]);
    return new Response(JSON.stringify({ success: true, result: { jwt: 'done' } }), { status: 201 });
  };
  assert.equal(await uploadStaticAssets(args(fetchFn)), 'done');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal(calls[1].auth, 'Bearer session');
});

test('empty buckets means the session JWT is already the completion token', async () => {
  assert.equal(await uploadStaticAssets(args(async () => ok({ jwt: 'session', buckets: [] }))), 'session');
});

test('fails closed on API errors and on a missing completion JWT', async () => {
  await assert.rejects(uploadStaticAssets(args(async () => new Response('{"success":false}', { status: 403 }))), /cloudflare_assets_403/);
  const noJwt = async url => url.endsWith('/assets-upload-session')
    ? ok({ jwt: 's', buckets: [[(await assetManifest(files)).manifest['/index.html'].hash]] }) : ok({});
  await assert.rejects(uploadStaticAssets(args(noJwt)), /assets_upload_incomplete/);
  assert.deepEqual(ASSETS_BINDING, { type: 'assets', name: 'ASSETS' });
});

test('bundled site-editor assets include the editor shell and pass manifest checks', async () => {
  const paths = SITE_EDITOR_ASSETS.map(f => f.path);
  assert.ok(paths.includes('/index.html') && paths.includes('/js/editor.js'));
  await assetManifest(SITE_EDITOR_ASSETS);
});
