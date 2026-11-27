import test from 'node:test';
import assert from 'node:assert/strict';
import {FUNNEL_STEPS, recordFunnel, countryFromRequest} from './funnel-analytics.mjs';

test('recordFunnel writes ordered blobs without PII and ignores bad steps', () => {
  const points = [];
  const env = {FUNNEL: {writeDataPoint: (p) => points.push(p)}};
  assert.equal(recordFunnel(env, 'land', {country: 'US', path: '/'}), true);
  assert.equal(recordFunnel(env, 'not_a_step'), false);
  assert.equal(recordFunnel({}, 'land'), false);
  assert.deepEqual(points[0], {
    blobs: ['land', 'US', '/'],
    doubles: [1],
    indexes: ['onboard']
  });
  assert.equal(recordFunnel(env, 'preview', {country: 'us'}), true);
  assert.equal(points[1].blobs[1], 'XX');
});

test('FUNNEL_STEPS cover the marketing → approve path', () => {
  assert.deepEqual([...FUNNEL_STEPS], [
    'land', 'start_github', 'github_ok', 'start_cloudflare', 'cloudflare_ok',
    'account_selected', 'preview', 'zip_preview', 'approve'
  ]);
});

test('countryFromRequest reads Cloudflare cf.country only', () => {
  assert.equal(countryFromRequest({cf: {country: 'DE'}}), 'DE');
  assert.equal(countryFromRequest({cf: {country: 'de'}}), '');
  assert.equal(countryFromRequest({}), '');
});
