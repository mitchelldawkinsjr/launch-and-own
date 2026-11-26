import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startMockServer} from './serve-onboarding-mock.mjs';

// node:http, because the mock server replaces globalThis.fetch with the provider mock.
const send = (port, path, {method = 'GET', headers = {}, body} = {}) => new Promise((resolve, reject) =>
  http.request({host: '127.0.0.1', port, path, method, headers}, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({res, body: text}));
  }).on('error', reject).end(body));
const get = (port, path) => send(port, path);

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

test('rejects foreign Host headers (DNS rebinding) and does not vouch for foreign origins', async () => {
  const server = await startMockServer({port: 0});
  const port = server.address().port;
  try {
    assert.equal((await send(port, '/', {headers: {host: 'evil.test:' + port}})).res.statusCode, 421);
    assert.equal((await send(port, '/', {headers: {host: 'localhost:' + port}})).res.statusCode, 200);
    // Sign in through mock consent and send a valid logout (real CSRF token) from both origins:
    // only the origin differs, so a foreign-origin failure proves the Worker's origin check still applies.
    const signIn = async () => {
      let cookie = '', path = '/connect/github', body = '';
      for (let i = 0; i < 5 && path; i++) {
        const r = await send(port, path, {headers: cookie ? {cookie} : {}});
        for (const c of r.res.headers['set-cookie'] || []) if (!/=;/.test(c)) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
        path = r.res.headers.location?.startsWith('/') ? r.res.headers.location : null;
        body = r.body;
      }
      return {cookie, csrf: body.match(/action="\/logout"[\s\S]*?name="csrf" value="([^"]+)"/)?.[1]};
    };
    const logout = async origin => {
      const {cookie, csrf} = await signIn();
      assert.ok(cookie && csrf, 'signed in with a logout form');
      return (await send(port, '/logout', {method: 'POST', body: 'csrf=' + csrf,
        headers: {cookie, origin, 'content-type': 'application/x-www-form-urlencoded'}})).res.statusCode;
    };
    assert.equal(await logout('https://evil.test'), 400);
    assert.ok([302, 303].includes(await logout('http://127.0.0.1:' + port)), 'local origin logout succeeds');
  } finally { server.close(); }
});
