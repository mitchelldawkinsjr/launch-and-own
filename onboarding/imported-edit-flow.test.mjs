import test from 'node:test';
import assert from 'node:assert/strict';
import {base64Decode, base64Encode, gitBlobSha} from '../imported/bytes.mjs';
import previewWorker from './zip-preview-worker.mjs';
import {approvePreview, connectTenant, harness, newPreview, originalFetch, post} from './worker-test-support.mjs';

const BASE = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const HEAD = 'b'.repeat(40);
const NEXT = 'e'.repeat(40);
const MOVED = 'f'.repeat(40);
const text = value => new TextEncoder().encode(value);

async function liveSite(h) {
  const tenant = await connectTenant(h);
  const id = await newPreview(h, tenant, {tagline: 'Original homepage headline'});
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  assert.equal((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);
  return {...tenant, id};
}

function localBucket() {
  const data = new Map();
  return {
    async put(key, bytes) { data.set(key, Buffer.from(bytes)); },
    async get(key, options) {
      const object = data.get(key);
      if (!object) return null;
      const { offset, length } = options?.range ?? { offset: 0, length: object.length };
      const bytes = object.subarray(offset, offset + length);
      return { size: object.length, arrayBuffer: () => new Response(bytes).arrayBuffer(), json: () => JSON.parse(bytes) };
    }
  };
}

function markImported(h, id) {
  const row = h.sqlite.prepare('SELECT plan_json FROM onboarding_launch_jobs WHERE id=?').get(id);
  const plan = JSON.parse(row.plan_json);
  delete plan.site;
  plan.zip = {id, digest: 'ab'.repeat(32), fileCount: 1, totalBytes: 32};
  h.sqlite.prepare('UPDATE onboarding_launch_jobs SET plan_json=? WHERE id=?').run(JSON.stringify(plan), id);
}

function installGit(h, files) {
  const state = {ref: null, pull: null, posts: []};
  const inner = h.fetchFn;
  const root = '/repos/tester/esp-willow-studio';
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const path = decodeURIComponent(new URL(url).pathname);
    const jsonBody = method !== 'GET' && (path.includes('/git/') || path.endsWith('/pulls'));
    const body = jsonBody ? JSON.parse(opts.body) : null;
    const json = (data, status = 200) => Response.json(data, {status});
    if (path === root + '/git/commits/' + BASE) return json({sha: BASE, tree: {sha: TREE}});
    if (path === root + '/git/commits/' + MOVED) return json({sha: MOVED, tree: {sha: TREE}});
    if (path === root + '/git/trees/' + TREE) return json({sha: TREE, truncated: false, tree: files.baseTree});
    if (path === root + '/git/trees/' + NEXT) return json({sha: NEXT, truncated: false, tree: await files.headTree()});
    if (path.startsWith(root + '/git/blobs/') && method === 'GET') {
      const sha = path.slice((root + '/git/blobs/').length);
      const bytes = files.blobs.get(sha);
      if (!bytes) return json({}, 404);
      return json({sha, encoding: 'base64', content: base64Encode(bytes)});
    }
    if (method === 'GET' && path.startsWith(root + '/git/ref/heads/launch-and-own/edit-'))
      return state.ref ? json({object: {sha: state.ref, type: 'commit'}}) : json({}, 404);
    if (path === root + '/git/refs' && method === 'POST') {
      state.posts.push('ref');
      state.ref = body.sha;
      return json({ref: body.ref, object: {sha: body.sha}}, 201);
    }
    if (path === root + '/git/blobs' && method === 'POST') {
      state.posts.push('blob');
      const bytes = base64Decode(body.content);
      const sha = await gitBlobSha(bytes);
      files.blobs.set(sha, bytes);
      return json({sha}, 201);
    }
    if (path === root + '/git/trees' && method === 'POST') {
      state.posts.push('tree');
      assert.equal(body.base_tree, TREE);
      return json({sha: NEXT}, 201);
    }
    if (path === root + '/git/commits' && method === 'POST') {
      state.posts.push('commit');
      assert.deepEqual(body.parents, [BASE]);
      state.ref = HEAD;
      return json({sha: HEAD}, 201);
    }
    if (method === 'PATCH' && path.startsWith(root + '/git/refs/heads/launch-and-own/edit-')) {
      state.posts.push('patch');
      state.ref = body.sha;
      return json({object: {sha: body.sha}});
    }
    if (path === root + '/commits/' + HEAD) {
      return json({
        sha: HEAD, parents: [{sha: BASE}], commit: {tree: {sha: NEXT}},
        files: [{filename: 'public/index.html', status: 'modified', sha: await gitBlobSha(files.nextHtml)}]
      });
    }
    if (path === root + '/pulls' && method === 'GET') return json(state.pull ? [state.pull] : []);
    if (path === root + '/pulls/7' && method === 'GET') return json(state.pull);
    if (path === root + '/pulls' && method === 'POST') {
      state.posts.push('pull');
      assert.equal(JSON.stringify(body).includes('ghu_'), false);
      assert.match(body.body, /does not merge/);
      state.pull = {
        number: 7, state: 'open', html_url: 'https://github.com/tester/esp-willow-studio/pull/7',
        head: {ref: body.head, sha: HEAD, repo: {id: 101}},
        base: {ref: 'main', sha: BASE, repo: {id: 101}},
        merged_at: null, merged: false
      };
      return json(state.pull, 201);
    }
    if (path.includes('/merge')) throw new Error('merge attempted');
    return inner(url, opts);
  };
  return state;
}

test('a live imported site can preview and approve one pull request without merging', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const tenant = await liveSite(h);
    assert.equal((await h.request('/imported-edit?id=' + tenant.id, {cookie: tenant.cookie})).status, 404);
    markImported(h, tenant.id);
    const history = await (await h.request('/history', {cookie: tenant.cookie})).text();
    assert.match(history, /Edit imported website/);
    assert.doesNotMatch(history, /Update this website/);

    const html = text('<!doctype html><html><body><h1>Willow Studio</h1></body></html>');
    const css = text('h1 { color: #1f4b3a; }\n');
    const readme = text('# site\n');
    const files = {
      nextHtml: text('<!doctype html><html><body><h1>River &amp; Pine</h1></body></html>'),
      blobs: new Map(),
      baseTree: [],
      headTree: async () => []
    };
    const [htmlSha, cssSha, readmeSha] = await Promise.all([gitBlobSha(html), gitBlobSha(css), gitBlobSha(readme)]);
    files.blobs.set(htmlSha, html);
    files.blobs.set(cssSha, css);
    files.blobs.set(readmeSha, readme);
    files.baseTree = [
      {path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha},
      {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha}
    ];
    files.headTree = async () => [
      {path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha},
      {path: 'public', mode: '040000', type: 'tree', sha: '1'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: await gitBlobSha(files.nextHtml)},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha}
    ];
    const state = installGit(h, files);
    const editor = await h.request('/imported-edit?id=' + tenant.id, {cookie: tenant.cookie});
    assert.equal(editor.status, 200);
    const editorHtml = await editor.text();
    assert.match(editorHtml, /does not merge or publish/);
    assert.match(editorHtml, /index\.html<\/code> \(visible text, link address, business email or phone\)/);
    assert.doesNotMatch(editorHtml, /styles\.css/);
    assert.match(editorHtml, /Preview this edit/);
    const pkg = text('{"name":"site"}\n');
    const pkgSha = await gitBlobSha(pkg);
    files.blobs.set(pkgSha, pkg);
    const staticTree = files.baseTree;
    files.baseTree = [
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha},
      {path: 'public/package.json', mode: '100644', type: 'blob', sha: pkgSha}
    ];
    const blocked = await h.request('/imported-edit?id=' + tenant.id, {cookie: tenant.cookie});
    assert.equal(blocked.status, 200);
    const blockedHtml = await blocked.text();
    assert.match(blockedHtml, /unbuilt project/);
    assert.doesNotMatch(blockedHtml, /Preview this edit/);
    files.baseTree = staticTree;
    const bad = await post(h, '/imported-edit-preview', tenant.cookie, {
      csrf: 'incorrect', id: tenant.id, kind: 'text', path: 'index.html', old: 'Willow Studio', replacement: 'River & Pine'
    });
    assert.equal(bad.status, 400);
    assert.equal(state.posts.length, 0);
    const preview = await post(h, '/imported-edit-preview', tenant.cookie, {
      csrf: tenant.csrf, id: tenant.id, kind: 'text', path: 'index.html', old: 'Willow Studio', replacement: 'River & Pine'
    });
    assert.equal(preview.status, 303, await preview.text());
    const ticket = new URL('https://onboard.example.com' + preview.headers.get('location')).searchParams.get('ticket');
    const review = await h.request('/imported-edit-review?ticket=' + ticket, {cookie: tenant.cookie});
    assert.equal(review.status, 200);
    const reviewHtml = await review.text();
    assert.match(reviewHtml, /Approve and open a pull request/);
    assert.match(reviewHtml, /Preview ready/);
    assert.match(reviewHtml, /See the exact changed file/);
    assert.doesNotMatch(reviewHtml, /Open the exact preview/);
    assert.equal(reviewHtml.includes('ghu_'), false);
    const field = name => reviewHtml.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];
    const binding = {
      approvalId: field('approvalId'), proposalDigest: field('proposalDigest'), artifactDigest: field('artifactDigest')
    };
    const exact = await h.request('/imported-edit-file?ticket=' + ticket + '&path=index.html', {cookie: tenant.cookie});
    assert.equal(exact.status, 200);
    assert.match(exact.headers.get('content-security-policy'), /script-src 'none'/);
    assert.equal(exact.headers.get('set-cookie'), null);
    assert.match(await exact.text(), /River &amp; Pine/);
    assert.equal(state.posts.length, 0);
    Object.assign(h.env, {
      ZIP_ARTIFACTS: localBucket(), ZIP_PREVIEW_DOMAIN: '-zp.example.test', ZIP_PREVIEW_KEY: 'cd'.repeat(32)
    });
    const isolated = await post(h, '/imported-edit-preview', tenant.cookie, {
      csrf: tenant.csrf, id: tenant.id, kind: 'text', path: 'index.html', old: 'Willow Studio', replacement: 'River & Pine'
    });
    assert.equal(isolated.status, 303, await isolated.text());
    const isolatedTicket = new URL('https://onboard.example.com' + isolated.headers.get('location')).searchParams.get('ticket');
    const isolatedReview = await h.request('/imported-edit-review?ticket=' + isolatedTicket, {cookie: tenant.cookie});
    const isolatedHtml = await isolatedReview.text();
    const previewForm = isolatedHtml.match(/<form action="(https:\/\/[^"]+\/_open)" method="POST" target="_blank"><input name="ticket" type="hidden" value="([^"]+)">/);
    assert.ok(previewForm);
    assert.match(isolatedReview.headers.get('content-security-policy'), /form-action 'self' https:\/\/[a-f0-9-]+-zp\.example\.test/);
    assert.doesNotMatch(isolatedHtml, /externalAssets/);
    // Browsers derive the cross-site form Origin from this; same-origin would send Origin: null.
    assert.equal(isolatedReview.headers.get('referrer-policy'), 'origin');
    const nullOrigin = await previewWorker.fetch(new Request(previewForm[1], {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket: previewForm[2] })
    }), h.env);
    assert.equal(nullOrigin.status, 404);
    assert.equal(state.posts.length, 0);
    const opened = await previewWorker.fetch(new Request(previewForm[1], {
      method: 'POST',
      headers: { origin: 'https://onboard.example.com', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket: previewForm[2] })
    }), h.env);
    assert.equal(opened.status, 303);
    const served = await previewWorker.fetch(new Request(new URL(previewForm[1]).origin + '/', {
      headers: { cookie: opened.headers.get('set-cookie').split(';')[0] }
    }), h.env);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-security-policy'), /script-src 'none'/);
    assert.match(await served.text(), /River &amp; Pine/);
    assert.equal(state.posts.length, 0);
    const mismatched = await post(h, '/imported-edit-approve', tenant.cookie, {
      csrf: tenant.csrf, ticket, ...binding, approvalId: 'b'.repeat(32)
    });
    assert.equal(mismatched.status, 400);
    assert.match(await mismatched.text(), /no longer matches/);
    assert.equal(state.posts.length, 0);
    const approved = await post(h, '/imported-edit-approve', tenant.cookie, {csrf: tenant.csrf, ticket, ...binding});
    assert.equal(approved.status, 303, await approved.text());
    assert.deepEqual(state.posts, ['ref', 'blob', 'tree', 'commit', 'patch', 'pull']);
    const status = await h.request(approved.headers.get('location'), {cookie: tenant.cookie});
    const statusHtml = await status.text();
    assert.equal(status.status, 200);
    assert.match(statusHtml, /Pull request open/);
    assert.match(statusHtml, /does not publish the site/);
    assert.doesNotMatch(statusHtml, /Approve and open a pull request/);
    assert.doesNotMatch(statusHtml, /published production revision matches/);
    assert.equal(statusHtml.includes('ghu_'), false);
    const writes = state.posts.length;
    h.resourceState.headSha = MOVED;
    const stale = await post(h, '/imported-edit-approve', tenant.cookie, {csrf: tenant.csrf, ticket, ...binding});
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /GitHub main changed/);
    assert.equal(state.posts.length, writes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
