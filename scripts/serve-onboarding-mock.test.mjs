import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startMockServer} from './serve-onboarding-mock.mjs';

// node:http, because the mock server replaces globalThis.fetch with the provider mock.
const get = (port, path, cookie = '') => new Promise((resolve, reject) =>
  http.get({host: '127.0.0.1', port, path, headers: cookie ? {cookie} : {}}, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({res, body}));
  }).on('error', reject));

test('mock server serves the real landing (ZIP off and on) with Worker security headers, local only', async () => {
  for (const zip of [false, true]) {
    const server = await startMockServer({port: 0, zip});
    try {
      assert.equal(server.address().address, '127.0.0.1');
      const {res, body} = await get(server.address().port, '/');
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-security-policy'], /default-src 'none'/);
      assert.match(body, zip ? /Build anywhere\. Own everything\./ : /Describe it\. Launch it\. Own it\./);
    } finally { server.close(); }
  }
});

test('mock consent goes to the local callback, never to a real provider', async () => {
  const server = await startMockServer({port: 0});
  try {
    const {res} = await get(server.address().port, '/connect/github');
    assert.ok([302, 303].includes(res.statusCode));
    assert.match(res.headers.location, /^\/oauth\/github\/callback\?code=good&state=/);
  } finally { server.close(); }
});
