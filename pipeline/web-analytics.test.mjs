import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsBuildConfig, ensureWebAnalyticsSite, matchesApprovedBytes, projectBeaconToken, withoutProjectBeacon} from './web-analytics.mjs';

const account = 'a'.repeat(32);
const host = 'esp-willow-studio-site.pages.dev';
const TAG = '1c'.repeat(16), TOKEN = '2d'.repeat(16);

function fakeApi(sites) {
  const calls = [];
  return {calls, async cloudflare(path, opts = {}) {
    calls.push({path, method: opts.method || 'GET', body: opts.body});
    if (path.endsWith('/list?per_page=100')) return sites;
    return {site_tag: TAG, site_token: TOKEN, host: opts.body.host};
  }};
}

test('creates one Web Analytics site for the pages.dev host, and reuses it on a retry', async () => {
  const fresh = fakeApi([]);
  assert.deepEqual(await ensureWebAnalyticsSite(fresh, account, host), {tag: TAG, token: TOKEN});
  assert.deepEqual(fresh.calls.map(call => call.method), ['GET', 'POST']);
  assert.deepEqual(fresh.calls[1].body, {host, auto_install: false});
  const retry = fakeApi([{site_tag: TAG, site_token: TOKEN, host}]);
  assert.deepEqual(await ensureWebAnalyticsSite(retry, account, host), {tag: TAG, token: TOKEN});
  assert.deepEqual(retry.calls.map(call => call.method), ['GET']);
  assert.deepEqual(analyticsBuildConfig({tag: TAG, token: TOKEN}), {web_analytics_tag: TAG, web_analytics_token: TOKEN});
  assert.deepEqual(analyticsBuildConfig(null), {});
  await assert.rejects(ensureWebAnalyticsSite(fresh, account, 'evil.example.com'), /Invalid Web Analytics target/);
  await assert.rejects(ensureWebAnalyticsSite({cloudflare: async () => ({site_tag: 'x'})}, account, host), /usable/);
});

test('only the project\'s own Pages beacon is allowed on top of the approved bytes', () => {
  const approved = '<!doctype html><html><body><h1>Willow</h1></body></html>';
  const bytes = text => new TextEncoder().encode(text);
  const beacon = token => '<!-- Cloudflare Pages Analytics --><script defer src=\'https://static.cloudflareinsights.com/beacon.min.js\' data-cf-beacon=\'{"token": "' + token + '"}\'></script><!-- Cloudflare Pages Analytics -->';
  const served = approved.replace('</body>', beacon(TOKEN) + '</body>');
  assert.equal(matchesApprovedBytes(bytes(served), bytes(approved), TOKEN), true);
  assert.equal(matchesApprovedBytes(bytes(approved.replace('</body>', '\n' + beacon(TOKEN) + '\n</body>')), bytes(approved), TOKEN), true);
  assert.equal(matchesApprovedBytes(bytes(approved), bytes(approved), TOKEN), true);
  // A different token, an extra script, or changed content never passes.
  assert.equal(matchesApprovedBytes(bytes(approved.replace('</body>', beacon('3e'.repeat(16)) + '</body>')), bytes(approved), TOKEN), false);
  assert.equal(matchesApprovedBytes(bytes(served.replace('</body>', '<script src="https://evil.example/x.js"></script></body>')), bytes(approved), TOKEN), false);
  assert.equal(matchesApprovedBytes(bytes(served.replace('Willow', 'Other')), bytes(approved), TOKEN), false);
  assert.equal(matchesApprovedBytes(bytes(served), bytes(approved), null), false);
  assert.equal(withoutProjectBeacon(bytes(served + beacon(TOKEN)), TOKEN).length, 0);
  assert.equal(projectBeaconToken({build_config: {web_analytics_token: TOKEN}}), TOKEN);
  assert.equal(projectBeaconToken({build_config: {web_analytics_token: 'nope'}}), null);
});
