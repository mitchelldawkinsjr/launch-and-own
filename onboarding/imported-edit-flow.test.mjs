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
  const state = {ref: null, pull: null, posts: [], merges: []};
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
        files: files.commitFiles ? await files.commitFiles() : [{filename: 'public/index.html', status: 'modified', sha: await gitBlobSha(files.nextHtml)}]
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
    if (path === root + '/pulls/7/merge' && method === 'PUT' && state.allowMerge) {
      // "Approve and publish": only the exact approved head; a test can make GitHub refuse.
      const merge = JSON.parse(opts.body);
      state.merges.push(merge);
      if (state.denyMerge || merge.sha !== HEAD) return json({message: 'not mergeable'}, 405);
      state.pull = {...state.pull, state: 'closed', merged: true, merged_at: '2026-11-26T12:00:00Z', merge_commit_sha: '9'.repeat(40)};
      return json({merged: true, sha: '9'.repeat(40)});
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
    assert.match(editorHtml, /When you approve, we publish exactly that change/);
    assert.match(editorHtml, /open a pull request instead/);
    assert.match(editorHtml, /ve-targets/);
    assert.match(editorHtml, /Willow Studio/);
    assert.match(editorHtml, /Preview this edit/);
    assert.match(editorHtml, /\/site-editor\/index\.html\?id=/);
    assert.match(editorHtml, /page=index\.html/);
    assert.match(editorHtml, /#csrf=/);
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
    // No page given: the server finds the one file that holds the text.
    const located = await post(h, '/imported-edit-preview', tenant.cookie, {
      csrf: tenant.csrf, id: tenant.id, kind: 'text', path: '', old: 'Willow Studio', replacement: 'River & Pine'
    });
    assert.equal(located.status, 303, await located.text());
    const missing = await post(h, '/imported-edit-preview', tenant.cookie, {
      csrf: tenant.csrf, id: tenant.id, kind: 'text', path: '', old: 'Text that is nowhere', replacement: 'x'
    });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /could not find that text on any page/);
    assert.equal(state.posts.length, 0);
    const ticket = new URL('https://onboard.example.com' + preview.headers.get('location')).searchParams.get('ticket');
    const review = await h.request('/imported-edit-review?ticket=' + ticket, {cookie: tenant.cookie});
    assert.equal(review.status, 200);
    const reviewHtml = await review.text();
    assert.match(reviewHtml, /Approve and publish/);
    assert.match(reviewHtml, /Open a pull request instead/);
    assert.match(reviewHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Preview</);
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
    // This test covers the pull-request choice; publishing has its own tests below.
    const approved = await post(h, '/imported-edit-approve', tenant.cookie, {csrf: tenant.csrf, ticket, ...binding, action: 'pr'});
    assert.equal(approved.status, 303, await approved.text());
    assert.deepEqual(state.posts, ['ref', 'blob', 'tree', 'commit', 'patch', 'pull']);
    const status = await h.request(approved.headers.get('location'), {cookie: tenant.cookie});
    const statusHtml = await status.text();
    assert.equal(status.status, 200);
    assert.match(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Merge</);
    assert.match(statusHtml, /<a href="https:\/\/github\.com\/tester\/esp-willow-studio\/pull\/7" target="_blank" rel="noopener noreferrer">Open the pull request<\/a> \(opens in a new tab\)/);
    assert.match(statusHtml, /does not publish the site/);
    assert.doesNotMatch(statusHtml, /Approve and publish/);
    assert.doesNotMatch(statusHtml, /published production revision matches/);
    assert.equal(statusHtml.includes('ghu_'), false);
    const writes = state.posts.length;
    h.resourceState.headSha = MOVED;
    const stale = await post(h, '/imported-edit-approve', tenant.cookie, {csrf: tenant.csrf, ticket, ...binding, action: 'pr'});
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /GitHub main changed/);
    assert.equal(state.posts.length, writes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function approvedImportedEdit(h, {action, denyMerge = false} = {}) {
  const tenant = await liveSite(h);
  markImported(h, tenant.id);
  const html = text('<!doctype html><html><body><h1>Willow Studio</h1></body></html>');
  const readme = text('# site\n');
  const [htmlSha, readmeSha] = await Promise.all([gitBlobSha(html), gitBlobSha(readme)]);
  const files = {nextHtml: text('<!doctype html><html><body><h1>River &amp; Pine</h1></body></html>'), blobs: new Map([[htmlSha, html], [readmeSha, readme]])};
  files.baseTree = [
    {path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha},
    {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
    {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha}
  ];
  files.headTree = async () => [
    {path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha},
    {path: 'public', mode: '040000', type: 'tree', sha: '1'.repeat(40)},
    {path: 'public/index.html', mode: '100644', type: 'blob', sha: await gitBlobSha(files.nextHtml)}
  ];
  const state = installGit(h, files);
  Object.assign(state, {allowMerge: true, denyMerge});
  const preview = await post(h, '/imported-edit-preview', tenant.cookie, {
    csrf: tenant.csrf, id: tenant.id, kind: 'text', path: 'index.html', old: 'Willow Studio', replacement: 'River & Pine'
  });
  assert.equal(preview.status, 303, await preview.text());
  const ticket = new URL('https://onboard.example.com' + preview.headers.get('location')).searchParams.get('ticket');
  const reviewHtml = await (await h.request('/imported-edit-review?ticket=' + ticket, {cookie: tenant.cookie})).text();
  const field = name => reviewHtml.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];
  const approved = await post(h, '/imported-edit-approve', tenant.cookie, {
    csrf: tenant.csrf, ticket, approvalId: field('approvalId'), proposalDigest: field('proposalDigest'), artifactDigest: field('artifactDigest'),
    ...(action ? {action} : {})
  });
  assert.equal(approved.status, 303, await approved.clone().text());
  const statusHtml = await (await h.request(approved.headers.get('location'), {cookie: tenant.cookie})).text();
  return {state, statusHtml};
}

test('Approve and publish merges exactly the approved head once (owner decision 2026-11-26)', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const {state, statusHtml} = await approvedImportedEdit(h, {action: 'publish'});
    assert.deepEqual(state.posts, ['ref', 'blob', 'tree', 'commit', 'patch', 'pull']);
    assert.equal(state.merges.length, 1);
    assert.equal(state.merges[0].sha, HEAD);
    assert.equal(state.merges[0].merge_method, 'squash');
    // The timeline lists every step; the current one carries aria-current.
    assert.match(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Publish<|All steps done/);
    assert.doesNotMatch(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Merge</);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('approving with no choice publishes; a merge GitHub refuses leaves the PR open with an explanation', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const {state, statusHtml} = await approvedImportedEdit(h, {denyMerge: true});
    assert.equal(state.merges.length, 1, 'default action publishes');
    assert.match(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Merge</);
    assert.match(statusHtml, /GitHub did not allow an automatic merge/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an owner connects the existing contact form through one approved pull request', async () => {
  const {connectContactForm} = await import('./form-connect.mjs');
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const tenant = await liveSite(h);
    markImported(h, tenant.id);
    const page = '<!doctype html><html><head></head><body><form id="booking-form"><input name="name">' +
      '<input name="email" type="email"><button type="submit" disabled>Send</button></form></body></html>';
    const html = text(page);
    const htmlSha = await gitBlobSha(html);
    const workerUrl = 'https://esp-willow-studio-site-form.acct.workers.dev';
    const files = {
      nextHtml: text(connectContactForm(page, {formIndex: 0, workerUrl, sitekey: '0x4AAAAAAAtestkey'})),
      blobs: new Map([[htmlSha, html]]),
      baseTree: [
        {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
        {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha}
      ]
    };
    files.headTree = async () => [
      {path: 'public', mode: '040000', type: 'tree', sha: '1'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: await gitBlobSha(files.nextHtml)}
    ];
    const state = installGit(h, files);
    const notReady = await h.request('/form-connect?id=' + tenant.id, {cookie: tenant.cookie});
    assert.equal(notReady.status, 400);
    assert.match(await notReady.text(), /Set up the form service first/);

    // The approved forms setup recorded a deployed Worker for this site.
    const time = Math.floor(Date.now() / 1000);
    const job = h.sqlite.prepare('SELECT * FROM onboarding_launch_jobs WHERE id=?').get(tenant.id);
    h.sqlite.prepare(`INSERT INTO onboarding_option_approvals(id, job_id, github_user_id, cloudflare_account_id, kind,
      approval_digest, payload_json, status, created_at, updated_at) VALUES ('forms-1', ?, ?, ?, 'forms', ?, '{}', 'stored', ?, ?)`)
      .run(tenant.id, job.github_user_id, job.cloudflare_account_id, 'b'.repeat(64), time, time);
    h.sqlite.prepare(`INSERT INTO onboarding_forms_provisioning(forms_option_approval_id, job_id, github_user_id,
      cloudflare_account_id, gate_approval_id, widget_sitekey, database_id, schema_applied, worker_deployed,
      worker_subdomain_enabled, worker_schedule_set, worker_url, created_at, updated_at)
      VALUES ('forms-1', ?, ?, ?, 'gate_0001', '0x4AAAAAAAtestkey', '11111111-2222-3333-4444-555555555555', 1, 1, 1, 1, ?, ?, ?)`)
      .run(tenant.id, job.github_user_id, job.cloudflare_account_id, workerUrl, time, time);

    const review = await h.request('/form-connect?id=' + tenant.id, {cookie: tenant.cookie});
    const reviewHtml = await review.text();
    assert.equal(review.status, 200, reviewHtml);
    assert.match(reviewHtml, /<code>booking-form<\/code>/);
    assert.match(reviewHtml, /Spam protection \(Cloudflare Turnstile\) is added/);
    assert.match(reviewHtml, /Only <code>public\/index\.html<\/code> changes/);
    assert.doesNotMatch(reviewHtml, /Check this page's own script/, 'no inline script, no warning');
    assert.equal(state.posts.length, 0, 'reviewing writes nothing');
    const field = name => reviewHtml.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];
    const fields = {ticket: field('ticket'), approvalId: field('approvalId'), proposalDigest: field('proposalDigest'),
      artifactDigest: field('artifactDigest')};
    const forged = await post(h, '/form-connect-approve', tenant.cookie, {csrf: tenant.csrf, ...fields, approvalId: 'c'.repeat(32)});
    assert.equal(forged.status, 400);
    assert.equal(state.posts.length, 0);
    const approved = await post(h, '/form-connect-approve', tenant.cookie, {csrf: tenant.csrf, ...fields});
    assert.equal(approved.status, 303, await approved.text());
    assert.deepEqual(state.posts, ['ref', 'blob', 'tree', 'commit', 'patch', 'pull']);
    const written = [...files.blobs.values()].map(bytes => new TextDecoder().decode(bytes)).find(value => value.includes('cf-turnstile'));
    assert.match(written, /action="https:\/\/esp-willow-studio-site-form\.acct\.workers\.dev\/submit" method="post"/);
    assert.match(written, /<button type="submit">Send<\/button>/);
    const status = await (await h.request(approved.headers.get('location'), {cookie: tenant.cookie})).text();
    assert.match(status, /Merge it yourself in GitHub/);
    const replay = await post(h, '/form-connect-approve', tenant.cookie, {csrf: tenant.csrf, ...fields});
    assert.notEqual(replay.status, 303, 'the approval works once');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a visual page save opens review and does not write GitHub', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  Object.assign(h.env, {
    ZIP_ARTIFACTS: localBucket(),
    ZIP_PREVIEW_DOMAIN: 'preview.example.test',
    ZIP_PREVIEW_KEY: 'cd'.repeat(32)
  });
  try {
    const tenant = await liveSite(h);
    markImported(h, tenant.id);
    const html = text('<!doctype html><html><body><h1>Willow Studio</h1></body></html>');
    const css = text('h1 { color: #1f4b3a; }\n');
    const files = {
      nextHtml: text('<!doctype html><html><body><h1>Harbor Lane</h1></body></html>'),
      blobs: new Map(),
      baseTree: [],
      headTree: async () => []
    };
    const [htmlSha, cssSha] = await Promise.all([gitBlobSha(html), gitBlobSha(css)]);
    files.blobs.set(htmlSha, html);
    files.blobs.set(cssSha, css);
    files.baseTree = [
      {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha}
    ];
    const state = installGit(h, files);
    const editorHtml = await (await h.request('/imported-edit?id=' + tenant.id, {cookie: tenant.cookie})).text();
    assert.match(editorHtml, /\/site-editor\/index\.html\?id=/);
    const listed = await h.request('/imported-edit-files?id=' + tenant.id, {cookie: tenant.cookie});
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).files, ['index.html', 'styles.css']);
    const visual = await h.request('/imported-edit-visual-preview', {
      method: 'POST', cookie: tenant.cookie,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        csrf: tenant.csrf, id: tenant.id, page: 'index.html',
        html: '<!doctype html><html><body><h1>Harbor Lane</h1></body></html>',
        images: []
      })
    });
    assert.equal(visual.status, 303, await visual.text());
    assert.match(visual.headers.get('location'), /^\/imported-edit-review\?ticket=/);
    assert.equal(state.posts.length, 0);
    const formPreview = await h.request('/imported-edit-visual-preview', {
      method: 'POST', cookie: tenant.cookie,
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        csrf: tenant.csrf, id: tenant.id, page: 'index.html',
        html: '<!doctype html><html><body><h1>Harbor Form</h1></body></html>',
        images: '[]'
      }).toString()
    });
    assert.equal(formPreview.status, 303, await formPreview.text());
    assert.match(formPreview.headers.get('location'), /^\/imported-edit-review\?ticket=/);
    const reviewHtml = await (await h.request(visual.headers.get('location'), {cookie: tenant.cookie})).text();
    assert.match(reviewHtml, /Files in this visual edit/);
    assert.match(reviewHtml, /Updated page/);
    assert.match(reviewHtml, /Approve and publish/);
    const scripted = await h.request('/imported-edit-visual-preview', {
      method: 'POST', cookie: tenant.cookie,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        csrf: tenant.csrf, id: tenant.id, page: 'index.html',
        html: '<!doctype html><html><body><script>alert(1)</script></body></html>',
        images: []
      })
    });
    assert.equal(scripted.status, 400);
    assert.equal(state.posts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a visual save accept opens the pull request and merges it', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  Object.assign(h.env, {
    ZIP_ARTIFACTS: localBucket(),
    ZIP_PREVIEW_DOMAIN: 'preview.example.test',
    ZIP_PREVIEW_KEY: 'cd'.repeat(32)
  });
  try {
    const tenant = await liveSite(h);
    markImported(h, tenant.id);
    const html = text('<!doctype html><html><body><h1>Willow Studio</h1></body></html>');
    const css = text('h1 { color: #1f4b3a; }\n');
    const nextHtml = text('<!doctype html><html><body><h1>Harbor Lane</h1></body></html>');
    const files = {nextHtml, blobs: new Map(), baseTree: [], headTree: async () => []};
    const [htmlSha, cssSha, nextSha] = await Promise.all([gitBlobSha(html), gitBlobSha(css), gitBlobSha(nextHtml)]);
    files.blobs.set(htmlSha, html);
    files.blobs.set(cssSha, css);
    files.baseTree = [
      {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha}
    ];
    files.headTree = async () => [
      {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: nextSha},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha}
    ];
    const state = installGit(h, files);
    state.allowMerge = true;
    const visual = await h.request('/imported-edit-visual-preview', {
      method: 'POST', cookie: tenant.cookie,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        csrf: tenant.csrf, id: tenant.id, page: 'index.html',
        html: '<!doctype html><html><body><h1>Harbor Lane</h1></body></html>',
        images: []
      })
    });
    assert.equal(visual.status, 303, await visual.text());
    assert.equal(state.posts.length, 0, 'preview does not write GitHub');
    const reviewHtml = await (await h.request(visual.headers.get('location'), {cookie: tenant.cookie})).text();
    const field = name => reviewHtml.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];
    const approved = await post(h, '/imported-edit-approve', tenant.cookie, {
      csrf: tenant.csrf, ticket: field('ticket'), approvalId: field('approvalId'),
      proposalDigest: field('proposalDigest'), artifactDigest: field('artifactDigest'), action: 'publish'
    });
    assert.equal(approved.status, 303, await approved.text());
    assert.deepEqual(state.posts, ['ref', 'blob', 'tree', 'commit', 'patch', 'pull']);
    assert.equal(state.merges.length, 1);
    assert.equal(state.merges[0].sha, HEAD);
    assert.equal(state.merges[0].merge_method, 'squash');
    const statusHtml = await (await h.request(approved.headers.get('location'), {cookie: tenant.cookie})).text();
    assert.match(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Publish</);
    assert.doesNotMatch(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Merge</);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a visual save with a new image opens a pull request only after approval', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  Object.assign(h.env, {
    ZIP_ARTIFACTS: localBucket(),
    ZIP_PREVIEW_DOMAIN: 'preview.example.test',
    ZIP_PREVIEW_KEY: 'cd'.repeat(32)
  });
  try {
    const tenant = await liveSite(h);
    markImported(h, tenant.id);
    const html = text('<!doctype html><html><body><h1>Willow Studio</h1></body></html>');
    const css = text('h1 { color: #1f4b3a; }\n');
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
    const nextHtml = text('<!doctype html><html><body><h1>Harbor Lane</h1><img src="images/lo-1.png" alt="Storefront"></body></html>');
    const files = {nextHtml, blobs: new Map(), baseTree: [], headTree: async () => [], commitFiles: null};
    const [htmlSha, cssSha, pngSha, nextSha] = await Promise.all([gitBlobSha(html), gitBlobSha(css), gitBlobSha(png), gitBlobSha(nextHtml)]);
    files.blobs.set(htmlSha, html);
    files.blobs.set(cssSha, css);
    files.baseTree = [
      {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: htmlSha},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha}
    ];
    files.headTree = async () => [
      {path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40)},
      {path: 'public/images', mode: '040000', type: 'tree', sha: '3'.repeat(40)},
      {path: 'public/index.html', mode: '100644', type: 'blob', sha: nextSha},
      {path: 'public/styles.css', mode: '100644', type: 'blob', sha: cssSha},
      {path: 'public/images/lo-1.png', mode: '100644', type: 'blob', sha: pngSha}
    ];
    files.commitFiles = async () => [
      {filename: 'public/index.html', status: 'modified', sha: nextSha},
      {filename: 'public/images/lo-1.png', status: 'added', sha: pngSha}
    ];
    const state = installGit(h, files);
    const visual = await h.request('/imported-edit-visual-preview', {
      method: 'POST', cookie: tenant.cookie,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        csrf: tenant.csrf, id: tenant.id, page: 'index.html',
        html: new TextDecoder().decode(nextHtml),
        images: [{path: 'images/lo-1.png', base64: base64Encode(png)}]
      })
    });
    assert.equal(visual.status, 303, await visual.text());
    assert.equal(state.posts.length, 0, 'preview does not write GitHub');
    const reviewHtml = await (await h.request(visual.headers.get('location'), {cookie: tenant.cookie})).text();
    assert.match(reviewHtml, /New image/);
    const field = name => reviewHtml.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];
    const approved = await post(h, '/imported-edit-approve', tenant.cookie, {
      csrf: tenant.csrf, ticket: field('ticket'), approvalId: field('approvalId'),
      proposalDigest: field('proposalDigest'), artifactDigest: field('artifactDigest'), action: 'pr'
    });
    assert.equal(approved.status, 303, await approved.text());
    assert.deepEqual(state.posts, ['ref', 'blob', 'blob', 'tree', 'commit', 'patch', 'pull']);
    const written = [...files.blobs.values()];
    assert.ok(written.some(bytes => bytes.length === png.length && bytes.every((byte, index) => byte === png[index])));
    assert.ok(written.some(bytes => new TextDecoder().decode(bytes).includes('Harbor Lane')));
    // Removed images must not be added: HTML without the src, but images[] still sent.
    const orphan = await h.request('/imported-edit-visual-preview', {
      method: 'POST', cookie: tenant.cookie,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        csrf: tenant.csrf, id: tenant.id, page: 'index.html',
        html: '<!doctype html><html><body><h1>Harbor Lane</h1></body></html>',
        images: [{path: 'images/lo-1.png', base64: base64Encode(png)}]
      })
    });
    assert.equal(orphan.status, 303, await orphan.text());
    const orphanReview = await (await h.request(orphan.headers.get('location'), {cookie: tenant.cookie})).text();
    assert.doesNotMatch(orphanReview, /New image|images\/lo-1\.png/);
    const statusHtml = await (await h.request(approved.headers.get('location'), {cookie: tenant.cookie})).text();
    assert.match(statusHtml, /aria-current="step"><span class="step-dot" aria-hidden="true">\d<\/span><span class="step-label">Merge</);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
