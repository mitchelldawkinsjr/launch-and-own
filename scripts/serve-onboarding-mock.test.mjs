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

test('editor fixture serves the site editor and a visual save reaches review', {concurrency: false}, async () => {
  const server = await startMockServer({port: 0, editorFixture: true});
  const port = server.address().port;
  try {
    const opened = await get(port, '/dev/open-editor');
    assert.equal(opened.res.statusCode, 302);
    const cookie = opened.res.headers['set-cookie'][0].split(';')[0];
    const editor = await send(port, opened.res.headers.location, {headers: {cookie}});
    assert.equal(editor.res.statusCode, 200);
    assert.match(editor.body, /\/site-editor\/index\.html\?id=/);
    assert.match(editor.body, /Saturday: 9 AM-2 PM/);
    const titleAt = editor.body.indexOf('Edit this page');
    const askAt = editor.body.indexOf('Ask your AI assistant');
    const frameAt = editor.body.indexOf('iframe title="Visual page editor"');
    assert.ok(titleAt >= 0 && titleAt < askAt && askAt < frameAt);
    const live = await send(port, '/imported-edit-live/' + opened.res.headers.location.match(/id=([^&]+)/)[1] + '/index.html', {headers: {cookie}});
    assert.equal(live.res.statusCode, 200);
    assert.match(live.body, /Example Bakery/);
    const shell = await get(port, '/site-editor/index.html');
    assert.equal(shell.res.statusCode, 200);
    assert.match(shell.body, /launch-own-host\.js/);
    assert.match(shell.res.headers['content-security-policy'], /frame-ancestors 'self'/);
    const id = opened.res.headers.location.match(/id=([^&]+)/)[1];
    const csrf = editor.body.match(/#csrf=([a-f0-9]+)/)[1];
    const saved = await send(port, '/imported-edit-visual-preview', {
      method: 'POST',
      headers: {cookie, origin: 'http://127.0.0.1:' + port, 'content-type': 'application/json'},
      body: JSON.stringify({
        csrf, id, page: 'index.html',
        html: '<!doctype html><html lang="en"><head><title>Example Bakery</title></head><body><h1>Harbor Lane Bakery</h1></body></html>',
        images: []
      })
    });
    assert.equal(saved.res.statusCode, 303, saved.body);
    assert.match(saved.res.headers.location, /^\/imported-edit-review\?ticket=/);
    const review = await send(port, saved.res.headers.location, {headers: {cookie}});
    assert.equal(review.res.statusCode, 200, review.body);
    assert.match(review.body, /Updated page/);
    assert.match(review.body, /Approve and publish/);
    const field = name => review.body.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];
    const approved = await send(port, '/imported-edit-approve', {
      method: 'POST',
      headers: {cookie, origin: 'http://127.0.0.1:' + port, 'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        csrf: field('csrf'), ticket: field('ticket'), approvalId: field('approvalId'),
        proposalDigest: field('proposalDigest'), artifactDigest: field('artifactDigest'), action: 'publish'
      }).toString()
    });
    assert.equal(approved.res.statusCode, 303, approved.body);
    const status = await send(port, approved.res.headers.location, {headers: {cookie}});
    assert.equal(status.res.statusCode, 200, status.body);
    assert.match(status.body, /aria-current="step">You merged/);
    assert.match(status.body, /https:\/\/github.com\/tester\/esp-willow-studio\/pull\/7/);
    assert.doesNotMatch(status.body, /aria-current="step">Pull request open/);
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
