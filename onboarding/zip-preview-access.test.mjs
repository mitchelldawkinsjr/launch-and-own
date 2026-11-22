import test from 'node:test';
import assert from 'node:assert/strict';
import { createZipPreview, verifyZipPreview, zipPreviewConfigured, zipPreviewHost } from './zip-preview-access.mjs';

const artifact = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', digest: 'a'.repeat(64), fileCount: 2, totalBytes: 120 };
const base = { ZIP_ARTIFACTS: {}, ONBOARDING_ORIGIN: 'https://onboard.example.test',
  ZIP_PREVIEW_KEY: 'c'.repeat(64), TOKEN_ENCRYPTION_KEY: 'd'.repeat(64) };
const later = () => Math.floor(Date.now() / 1000) + 3600;

test('sibling suffix gives one-level preview hosts that a *.domain certificate covers', async () => {
  const env = { ...base, ZIP_PREVIEW_DOMAIN: '-zp.example.test' };
  assert.equal(zipPreviewConfigured(env), true);
  assert.equal(zipPreviewHost(artifact.id, env.ZIP_PREVIEW_DOMAIN), artifact.id + '-zp.example.test');
  const { origin, ticket } = await createZipPreview(env, artifact, 'draft', later());
  assert.equal(origin, `https://${artifact.id}-zp.example.test`);
  assert.ok(await verifyZipPreview(env, new URL(origin + '/'), ticket));
  // The ticket is bound to its own host: no other upload, the dotted form, or the onboarding host.
  for (const host of [`${'1'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}-zp.example.test`,
    `${artifact.id}.zp.example.test`, 'onboard.example.test'])
    assert.equal(await verifyZipPreview(env, new URL(`https://${host}/`), ticket), null);
});

test('dotted preview domain keeps its existing host format', async () => {
  const env = { ...base, ZIP_PREVIEW_DOMAIN: 'preview.example.test' };
  assert.equal(zipPreviewConfigured(env), true);
  const { origin } = await createZipPreview(env, artifact, 'draft', later());
  assert.equal(origin, `https://${artifact.id}.preview.example.test`);
});

test('preview hosts can never collide with or sit under the onboarding host', () => {
  // An onboarding host that itself ends with the suffix would be reachable as a preview host.
  assert.equal(zipPreviewConfigured({ ...base, ONBOARDING_ORIGIN: 'https://app-zp.example.test', ZIP_PREVIEW_DOMAIN: '-zp.example.test' }), false);
  const unsafe = ['-zp.onboard.example.test', 'example.test', 'x.onboard.example.test',
    '-.example.test', '-zp', '-Zp.example.test', '-zp_x.example.test'];
  for (const ZIP_PREVIEW_DOMAIN of unsafe)
    assert.equal(zipPreviewConfigured({ ...base, ZIP_PREVIEW_DOMAIN }), false, ZIP_PREVIEW_DOMAIN);
});
