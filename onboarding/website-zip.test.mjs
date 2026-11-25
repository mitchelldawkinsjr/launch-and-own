import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import worker from './worker.mjs';
import previewWorker from './zip-preview-worker.mjs';
import { createZipPreview } from './zip-preview-access.mjs';
import { extractWebsiteZip } from './website-zip.mjs';
import { accountId, approvePreview, connectTenant, harness, jobRow, launchId, makeDue, moveLeaseIntoPast, origin,
  originalFetch, post, reviewDigest, writes } from './worker-test-support.mjs';

function zip(entries) {
  const locals = [], directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.data ?? '');
    const packed = entry.deflate ? Buffer.concat([deflateRawSync(data), Buffer.from(entry.trailing ?? [])]) : data;
    const size = entry.size ?? data.byteLength;
    const crc = crc32(data);
    const flags = 0x800 | (entry.descriptor ? 8 : 0) | (entry.flags ?? 0);
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    offset += local.length + name.length + packed.length;
    if (entry.descriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(size, 12);
      locals.push(descriptor);
      offset += descriptor.length;
    } else {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    directory.push(central, name);
  }
  const records = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(records.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, records, end]);
}

const home = '<!doctype html><title>Willow</title><link rel="stylesheet" href="/assets/site.css">'
  + '<script type="module" src="/assets/main.js"></script><a href="/about/">About</a>';
const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xa5, 13]);
const bundle = [
  { path: 'index.html', data: home, deflate: true, descriptor: true },
  { path: 'about/index.html', data: '<h1>About Willow</h1>' },
  { path: 'assets/site.css', data: 'body { color: green }' },
  { path: 'assets/main.js', data: 'export const title = "Willow";' },
  { path: 'assets/Willow Photo.png', data: photo }
];

test('ZIP keeps original page and binary bytes, removing only an enclosing folder and common metadata', async () => {
  const files = await extractWebsiteZip(zip([
    { path: 'dist/', attrs: 0x10, deflate: true },
    { path: '__MACOSX/dist/._index.html', data: photo },
    { path: 'dist/.DS_Store', data: photo },
    ...bundle.map(entry => ({ ...entry, path: 'dist/' + entry.path }))
  ]));
  assert.deepEqual(Object.fromEntries(files.map(file => [file.path, Buffer.from(file.bytes)])),
    Object.fromEntries(bundle.map(entry => [entry.path, Buffer.from(entry.data)])));
});

test('ZIP rejects invalid payloads, collisions, and files outside the static build', async () => {
  for (const [entry, message] of [
    [{ path: '../outside.html' }, /unsupported file name/],
    [{ path: '/absolute.html' }, /unsupported file name/],
    [{ path: 'foo\\outside.html' }, /unsupported file name/],
    [{ path: '.git/config' }, /unsupported file name/],
    [{ path: '_worker.js' }, /hosting configuration/],
    [{ path: 'functions/index.js' }, /hosting configuration/],
    [{ path: 'admin.php' }, /static files/],
    [{ path: 'nested/symlink.png', attrs: 0xa0000000 }, /regular files/],
    [{ path: 'INDEX.HTML' }, /duplicate/],
    [{ path: 'index.html/other.html' }, /conflicting/],
    [{ path: 'encrypted.html', flags: 1 }, /unencrypted/],
    [{ path: 'large.html', data: 'x', size: 3 * 1024 * 1024, deflate: true }, /extracted website/],
    [{ path: 'wrong-size.html', data: 'x'.repeat(8192), size: 1, deflate: true }, /invalid or corrupted/],
    [{ path: 'trailing-bytes.html', data: '<p>Contents</p>', trailing: [0], deflate: true }, /invalid or corrupted/]
  ]) {
    await assert.rejects(extractWebsiteZip(zip([bundle[0], entry])), message, entry.path);
  }
  await assert.rejects(extractWebsiteZip(zip([{ path: 'about.html', data: 'No homepage' }])), /Include index.html/);
  const modified = zip([{ path: 'index.html', data: home }]);
  modified[41] ^= 1;
  await assert.rejects(extractWebsiteZip(modified), /invalid or corrupted/);
});

function localBucket() {
  const data = new Map();
  return { data,
    async put(key, bytes) { data.set(key, Buffer.from(bytes)); },
    async head(key) { return data.has(key) ? { size: data.get(key).length } : null; },
    async get(key, options) {
      const object = data.get(key);
      if (!object) return null;
      const { offset, length } = options?.range ?? { offset: 0, length: object.length };
      const bytes = object.subarray(offset, offset + length);
      return { size: object.length, arrayBuffer: () => new Response(bytes).arrayBuffer(), json: () => JSON.parse(bytes) };
    }
  };
}

const starterSha = 'b'.repeat(40), starterTree = 'c'.repeat(40);
const approvedSha = 'd'.repeat(40), approvedTree = 'e'.repeat(40);
const repoRoot = 'https://api.github.com/repos/tester/esp-willow-studio';
const liveRoot = 'https://esp-willow-studio-site.pages.dev/';

function zipHarness(t) {
  const h = harness();
  const state = h.resourceState;
  Object.assign(h.env, { ZIP_ARTIFACTS: localBucket(), ZIP_PREVIEW_DOMAIN: 'preview.example.test', ZIP_PREVIEW_KEY: 'cd'.repeat(32) });
  const imported = { files: null, commits: 0, lostResponse: false, foreignHead: false, moveHead: false,
    publicBytes: null, currentCommit: approvedSha, currentHomepage: null };
  const fetchFn = async (url, options = {}) => {
    if (url === 'https://api.github.com/graphql') {
      const { query, variables } = JSON.parse(options.body);
      if (query.includes('query WebsiteImportBranch')) {
        assert.equal(variables.repo, 'github-repository-node-id');
        assert.equal(variables.ref, 'refs/heads/main');
        return Response.json({ data: { node: { name: state.repo.name, isPrivate: state.repo.private,
          owner: state.repo.owner, ref: { id: 'github-ref-node-id', target: {
            oid: imported.files ? approvedSha : starterSha, tree: { oid: imported.files ? approvedTree : starterTree }
          } } } } });
      }
      assert.match(query, /mutation CommitWebsiteImport/);
      assert.deepEqual(variables.input.branch, { id: 'github-ref-node-id' });
      assert.equal(variables.input.expectedHeadOid, starterSha);
      assert(!imported.files, 'the branch already contains a committed website');
      if (imported.moveHead) {
        imported.foreignHead = true;
        return Response.json({ errors: [{ type: 'STALE_DATA' }] });
      }
      imported.files = new Map(variables.input.fileChanges.additions.map(file => [file.path, Buffer.from(file.contents, 'base64')]));
      imported.commits++;
      if (imported.lostResponse) throw Error('response lost after commit');
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: approvedSha, tree: { oid: approvedTree } } } } });
    }
    if (url.startsWith(repoRoot + '/git/trees/')) {
      const tree = [{ path: 'README.md', mode: '100644', type: 'blob' }];
      if (url.includes(approvedTree)) {
        const dirs = new Set();
        for (const [path, bytes] of imported.files) {
          for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) dirs.add(path.slice(0, at));
          const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
          tree.push({ path, sha, mode: '100644', type: 'blob' });
        }
        for (const path of dirs) tree.push({ path, mode: '040000', type: 'tree' });
      }
      if (imported.foreignHead) tree.push({ path: 'customer-file.txt', mode: '100644', type: 'blob' });
      return Response.json({ truncated: false, tree });
    }
    if (url === repoRoot + '/branches/main') return Response.json({ commit: { sha: imported.currentCommit } });
    if (url === repoRoot + '/contents/public/index.html?ref=' + imported.currentCommit && imported.files) {
      const bytes = imported.currentHomepage ?? imported.files.get('public/index.html');
      const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      return Response.json({type: 'file', encoding: 'base64', size: bytes.length, sha, content: bytes.toString('base64')});
    }
    if (url === liveRoot) return new Response(imported.publicBytes ?? imported.files.get('public/index.html'),
      { headers: { 'content-type': 'text/html' } });
    const response = await h.fetchFn(url, options);
    if (url.endsWith('/user/repos') && response.ok) {
      state.repo.node_id = 'github-repository-node-id';
      return Response.json(state.repo, { status: 201 });
    }
    if (url.endsWith('/pages/projects') && options.method === 'POST' && response.ok) {
      assert.equal(jobRow(h).expected_commit_sha, approvedSha, 'commit checkpoint must precede Pages creation');
      state.pages.canonical_deployment.deployment_trigger.metadata.commit_hash = approvedSha;
    }
    return response;
  };
  globalThis.fetch = fetchFn;
  t.after(() => { globalThis.fetch = originalFetch; h.sqlite.close(); });
  return { ...h, imported };
}

async function upload(h, tenant, options = {}) {
  const form = new FormData();
  form.append('csrf', options.csrf ?? tenant.csrf);
  form.append('name', 'Willow Studio');
  form.append('zip', new Blob([options.bytes ?? zip(bundle)]), 'willow.zip');
  return await worker.fetch(new Request(origin + '/upload', { method: 'POST', body: form, headers: {
    origin: options.origin ?? origin, cookie: tenant.cookie
  } }), h.env);
}

async function privatePreviewChoices(h, tenant, id) {
  const interstitial = await h.request('/site-preview?id=' + id, { cookie: tenant.cookie });
  assert.equal(interstitial.status, 200);
  const html = await interstitial.text();
  const matches = html.matchAll(/action="(https:[^"]+)\/_open" method="POST"><input name="ticket" type="hidden" value="([A-Za-z0-9_-]+)"/g);
  const choices = Array.from(matches, ([, host, ticket]) => ({ host, ticket }));
  assert.equal(choices.length, 2);
  assert.ok(interstitial.headers.get('content-security-policy').includes('form-action ' + choices.map(choice => choice.host).join(' ')));
  assert.equal(interstitial.headers.get('referrer-policy'), 'origin');
  assert.match(html, /name="externalAssets" value="true" required/);
  return choices;
}

async function openPrivatePreview(h, tenant, id) {
  const [{ host, ticket }] = await privatePreviewChoices(h, tenant, id);
  const request = (path, options = {}) => previewWorker.fetch(new Request(host + path, options), h.env);
  const go = await request('/_open', { method: 'POST', headers: { origin }, body: new URLSearchParams({ ticket }) });
  assert.equal(go.status, 303);
  const session = go.headers.get('set-cookie');
  assert.match(session, /HttpOnly; Secure; SameSite=Lax/);
  assert.doesNotMatch(session, /Domain=/);
  const cookie = session.split(';')[0];
  return { host, cookie, fetch: (path, options) => request(path, { ...options, headers: { ...options?.headers, cookie } }) };
}

test('ZIP onboarding previews real files privately, approves the bundle, and verifies only the exact deployment', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  const setup = await (await h.request('/', { cookie: tenant.cookie })).text();
  assert(setup.indexOf('Upload a website you already built') < setup.indexOf('Create a simple website'));
  assert.equal((await upload(h, tenant, { origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await upload(h, tenant, { csrf: 'wrong' })).status, 400);
  assert.equal((await upload(h, tenant, { bytes: Buffer.alloc(7 * 1024 * 1024) })).status, 413);
  assert.equal(h.env.ZIP_ARTIFACTS.data.size, 0);
  const response = await upload(h, tenant);
  assert.equal(response.status, 303, await response.clone().text());
  const id = launchId(response);
  const review = await (await h.request('/review?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(review, /Uploaded website · 5 files/);
  assert.match(review, /Compatibility check/);
  assert.match(review, /Ready for a private preview/);
  assert.match(review, /Planned · not released/);
  assert.match(review, /assets\/Willow Photo\.png/);
  assert.match(review, /esp-willow-studio-site\.pages\.dev/);
  const preview = await openPrivatePreview(h, tenant, id);
  const page = await preview.fetch('/');
  assert.equal(await page.text(), home);
  const previewCsp = page.headers.get('content-security-policy');
  assert.match(previewCsp, /sandbox/);
  assert.match(previewCsp, /script-src 'none'/);
  assert.doesNotMatch(previewCsp, /allow-scripts|https:/);
  assert.match(previewCsp, /style-src 'self'/);
  assert.match(previewCsp, /img-src 'self'/);
  assert.match(previewCsp, /font-src 'self'/);
  assert.match(previewCsp, /connect-src 'none'/);
  assert.match(previewCsp, /form-action 'none'/);
  assert.equal(await (await preview.fetch('/about/index.html')).text(), '<h1>About Willow</h1>');
  assert.equal((await preview.fetch('/about')).headers.get('location'), preview.host + '/about/');
  const image = await preview.fetch('/assets/Willow%20Photo.png');
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), photo);
  assert.equal((await previewWorker.fetch(new Request(preview.host + '/'), h.env)).status, 404);
  assert.equal((await previewWorker.fetch(new Request(preview.host.replace(id, crypto.randomUUID()) + '/',
    { headers: { cookie: preview.cookie } }), h.env)).status, 404);
  h.resourceState.githubUserId = 55;
  const stranger = await connectTenant(h);
  assert.equal((await h.request('/site-preview?id=' + id, { cookie: stranger.cookie })).status, 404);
  h.resourceState.githubUserId = 42;
  assert.equal((await post(h, '/approve', tenant.cookie, { csrf: tenant.csrf, id, digest: 'a'.repeat(64) })).status, 400);
  assert.equal(writes(h).length, 0);
  assert.equal(h.imported.commits, 0);
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  assert.equal(jobRow(h).status, 'pending_deployment');
  assert.equal(h.imported.commits, 1);
  assert.deepEqual(h.imported.files, new Map(bundle.map(entry => ['public/' + entry.path, Buffer.from(entry.data)])));
  const canonical = h.resourceState.pages.canonical_deployment;
  canonical.deployment_trigger.metadata.commit_hash = starterSha;
  await post(h, '/verify', tenant.cookie, { id, csrf: tenant.csrf });
  assert.equal(jobRow(h).status, 'pending_deployment');
  canonical.deployment_trigger.metadata.commit_hash = approvedSha;
  h.imported.publicBytes = Buffer.from('different');
  makeDue(h);
  await post(h, '/verify', tenant.cookie, { id, csrf: tenant.csrf });
  assert.equal(jobRow(h).error_code, 'approved_html_not_served');
  h.imported.publicBytes = null;
  makeDue(h);
  await post(h, '/verify', tenant.cookie, { id, csrf: tenant.csrf });
  assert.equal(jobRow(h).status, 'live');
});

test('interactive ZIP preview needs explicit consent and an origin-bound ticket', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  const id = launchId(await upload(h, tenant));
  const [bundled, interactive] = await privatePreviewChoices(h, tenant, id);
  assert.notEqual(interactive.host, bundled.host);
  const open = (host, fields, source = origin) => previewWorker.fetch(new Request(host + '/_open', {
    method: 'POST', headers: { origin: source }, body: new URLSearchParams(fields)
  }), h.env);
  for (const rejected of [
    await open(interactive.host, { ticket: interactive.ticket }),
    await open(interactive.host, { ticket: bundled.ticket, externalAssets: 'true' }),
    await open(bundled.host, { ticket: interactive.ticket }),
    await open(interactive.host, { ticket: interactive.ticket, externalAssets: 'true' }, 'https://unrelated.example')
  ]) {
    assert.equal(rejected.status, 404);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  const accepted = await open(interactive.host, { ticket: interactive.ticket, externalAssets: 'true' });
  assert.equal(accepted.status, 303);
  const cookie = accepted.headers.get('set-cookie').split(';')[0];
  const fetchOn = host => previewWorker.fetch(new Request(host + '/', { headers: { cookie } }), h.env);
  assert.equal((await fetchOn(bundled.host)).status, 404);
  const page = await fetchOn(interactive.host);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), home);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts allow-same-origin/);
  for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src'])
    assert.match(csp, new RegExp(directive + '[^;]*https:'));
  for (const directive of ['worker-src', 'form-action', 'frame-ancestors'])
    assert.match(csp, new RegExp(directive + " 'none'"));
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(writes(h).length, 0);
});

test('expired preview capabilities cannot read or reopen a staged upload', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  const id = launchId(await upload(h, tenant));
  const stored = h.sqlite.prepare('SELECT plan_json FROM onboarding_launches WHERE id=?').get(id);
  const { zip: artifact } = JSON.parse(stored.plan_json);
  const preview = await createZipPreview(h.env, artifact, 'draft', Math.floor(Date.now() / 1000) - 1);
  const response = await previewWorker.fetch(new Request(preview.origin + '/_open', { method: 'POST',
    headers: { origin }, body: new URLSearchParams({ ticket: preview.ticket }) }), h.env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('a stalled ZIP launch verifies a dashboard-created Pages project, and the toolkit checks its later commit', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  h.resourceState.denyPagesOAuthAtCreate = true;
  const id = launchId(await upload(h, tenant));
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  const stalled = jobRow(h);
  assert.equal(stalled.status, 'needs_reauthorization');
  assert.equal(stalled.error_code, 'cloudflare_pages_http_401_cf10000');
  assert.equal(stalled.expected_commit_sha, approvedSha);
  assert.equal(stalled.pages_project_id, null);
  assert.equal(h.imported.commits, 1);
  assert.match(await (await h.request('/toolkit', {cookie: tenant.cookie})).text(), /Connect Cloudflare Pages access/);

  // Simulate the owner's separate Cloudflare dashboard creation.
  const token = 'fixture_dashboard_pages_access_token';
  h.resourceState.pagesAccessToken = token;
  const created = await h.fetchFn('https://api.cloudflare.com/client/v4/accounts/' + accountId + '/pages/projects', {
    method: 'POST', headers: {authorization: 'Bearer ' + token},
    body: JSON.stringify({build_config: {build_command: '', destination_dir: 'public', root_dir: '/'}})
  });
  assert.equal(created.status, 201);
  const project = h.resourceState.pages;
  project.source.config.preview_deployment_setting = 'all';
  project.canonical_deployment.deployment_trigger.metadata.commit_hash = approvedSha;
  const readsOnlyAfter = h.calls.length;
  assert.equal((await post(h, '/cloudflare-pages-access', tenant.cookie, {csrf: tenant.csrf, token, mode: 'read'})).status, 303);
  const accessId = h.sqlite.prepare('SELECT access_id FROM onboarding_pages_access').get().access_id;
  moveLeaseIntoPast(h);
  const restored = await post(h, '/restore', tenant.cookie, {csrf: tenant.csrf, id});
  assert.equal(restored.status, 303);
  const restoredId = launchId(restored);
  assert.match(await (await h.request('/review?id=' + restoredId, {cookie: tenant.cookie})).text(),
    /Approve and verify existing project/);
  h.imported.publicBytes = Buffer.from('<h1>Different live content</h1>');
  assert.equal((await post(h, '/approve', tenant.cookie, {csrf: tenant.csrf, id: restoredId,
    digest: await reviewDigest(h, tenant.cookie, restoredId), pagesAccessId: accessId})).status, 303);
  assert.equal(jobRow(h).status, 'pending_deployment');
  makeDue(h);
  h.imported.publicBytes = null;
  assert.equal((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id: restoredId})).status, 303);
  assert.equal(jobRow(h).status, 'live');
  assert.equal(jobRow(h).pages_project_id, project.id);
  assert.equal(jobRow(h).approval_digest, stalled.approval_digest);

  // A later GitHub merge is current inventory evidence. The original job keeps its original approval.
  h.imported.currentCommit = 'a'.repeat(40);
  h.imported.currentHomepage = Buffer.from('<!doctype html><html><h1>Current website</h1></html>');
  h.imported.publicBytes = h.imported.currentHomepage;
  project.canonical_deployment.id = 'later-owner-deployment';
  project.canonical_deployment.deployment_trigger.metadata.commit_hash = h.imported.currentCommit;
  const inventory = await (await h.request('/toolkit', {cookie: tenant.cookie})).text();
  const detailUrl = inventory.match(/href="(\/toolkit\/source\?ticket=[^"]+)"/)?.[1];
  assert.ok(detailUrl);
  const detail = await (await h.request(detailUrl, {cookie: tenant.cookie})).text();
  assert.match(detail, /Open verified homepage/);
  assert.match(detail, new RegExp(h.imported.currentCommit));
  assert.equal(jobRow(h).expected_commit_sha, approvedSha);
  assert.equal(project.source.config.preview_deployment_setting, 'all');
  assert.equal(h.imported.commits, 1);
  assert(h.calls.slice(readsOnlyAfter).every(request => request.method === 'GET'));
});

test('scheduled retry recovers a lost commit response using retained, byte-exact files', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  const id = launchId(await upload(h, tenant));
  h.imported.lostResponse = true;
  await approvePreview(h, tenant.cookie, tenant.csrf, id);
  assert.equal(jobRow(h).status, 'queued');
  assert.equal(jobRow(h).expected_commit_sha, null);
  assert.equal(h.resourceState.pages, null);
  for (const key of h.env.ZIP_ARTIFACTS.data.keys()) {
    if (key.includes('/draft/')) h.env.ZIP_ARTIFACTS.data.delete(key);
  }
  makeDue(h);
  await worker.scheduled({}, h.env);
  assert.equal(h.imported.commits, 1);
  assert.equal(jobRow(h).expected_commit_sha, approvedSha);
  assert.equal(jobRow(h).status, 'pending_deployment');
  await worker.scheduled({}, h.env);
  assert.equal(jobRow(h).status, 'live');
});

test('a changed branch does not get overwritten during import or recovery', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  const id = launchId(await upload(h, tenant));
  h.imported.moveHead = true;
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  assert.equal(jobRow(h).status, 'queued');
  makeDue(h);
  await worker.scheduled({}, h.env);
  assert.equal(jobRow(h).status, 'failed');
  assert.equal(h.imported.commits, 0);
  assert.equal(h.resourceState.pages, null);
});

test('reconnecting the same accounts opens a fresh review and resumes the retained import only on reapproval', async t => {
  const h = zipHarness(t);
  const first = await connectTenant(h);
  const id = launchId(await upload(h, first));
  await approvePreview(h, first.cookie, first.csrf, id, { skipFastPath: true });
  h.sqlite.prepare('DELETE FROM onboarding_sessions').run();
  await worker.scheduled({}, h.env);
  assert.equal(jobRow(h).status, 'needs_reauthorization');
  assert.equal(writes(h).length, 0);
  for (const key of h.env.ZIP_ARTIFACTS.data.keys()) {
    if (key.includes('/draft/')) h.env.ZIP_ARTIFACTS.data.delete(key);
  }
  const renewed = await connectTenant(h);
  const restored = await post(h, '/restore', renewed.cookie, { id, csrf: renewed.csrf });
  assert.equal(restored.status, 303);
  const reviewId = launchId(restored);
  assert.notEqual(reviewId, id);
  const preview = await openPrivatePreview(h, renewed, reviewId);
  assert.equal(await (await preview.fetch('/')).text(), home);
  assert.equal(writes(h).length, 0);
  assert.equal((await approvePreview(h, renewed.cookie, renewed.csrf, reviewId)).status, 303);
  assert.equal(jobRow(h).id, id);
  assert.equal(jobRow(h).status, 'pending_deployment');
});

test('approval and the runner independently reject changed archive bytes before provider writes', async t => {
  const h = zipHarness(t);
  const tenant = await connectTenant(h);
  const id = launchId(await upload(h, tenant));
  const objects = h.env.ZIP_ARTIFACTS.data;
  const draft = objects.get(`website-zip/draft/${id}/files`);
  const digest = await reviewDigest(h, tenant.cookie, id);
  draft[0] ^= 1;
  const rejected = await post(h, '/approve', tenant.cookie, { csrf: tenant.csrf, id, digest });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /no longer matches/);
  assert.equal(jobRow(h), undefined);
  draft[0] ^= 1;
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id, { skipFastPath: true })).status, 303);
  objects.get(`website-zip/approved/${id}/files`)[0] ^= 1;
  await worker.scheduled({}, h.env);
  assert.equal(jobRow(h).status, 'failed');
  assert.equal(jobRow(h).error_code, 'approved_zip_unavailable');
  assert.equal(h.imported.commits, 0);
  assert.equal(writes(h).length, 0);
});
