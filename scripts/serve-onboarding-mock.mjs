// Local onboarding Worker with mocked GitHub/Cloudflare, for screen-reader and visual QA. Never touches real providers.
// Usage: node scripts/serve-onboarding-mock.mjs [--zip] [--port 8787] [--repo <checkout of the release commit>]
// Requires Node 22.5+ (node:sqlite). Provider consent screens are skipped; every account is a fake test fixture.
// QA ONLY. Never expose it, bind it beyond 127.0.0.1, give it real secrets or real provider fetch, or deploy it.
import http from 'node:http';
import {readFileSync, readdirSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {base64Decode, base64Encode, gitBlobSha} from '../imported/bytes.mjs';
import {approvePreview, connectTenant, newPreview, post} from '../onboarding/worker-test-support.mjs';

const EDITOR_CSP = "default-src 'none'; script-src 'self' https://unpkg.com https://esm.sh 'sha256-AfmJSc5QuvGDXyNSsWg0p+yPCEM4Ax7GPPUQflvqTMQ='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://esm.sh https://unpkg.com; worker-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

function memoryBucket() {
  const data = new Map();
  return {
    async put(key, bytes) { data.set(key, Buffer.from(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes) ? bytes : await new Response(bytes).arrayBuffer())); },
    async delete(key) { data.delete(key); },
    async get(key, options) {
      const object = data.get(key);
      if (!object) return null;
      const {offset, length} = options?.range ?? {offset: 0, length: object.length};
      const bytes = object.subarray(offset, offset + length);
      return {size: object.length, arrayBuffer: () => new Response(bytes).arrayBuffer(), json: () => JSON.parse(bytes)};
    }
  };
}

// The local editor's one accept ("Approve and publish") creates the pull request and merges it.
// This stands in for GitHub only inside the editor fixture. It never talks to api.github.com.
function editorPublishMock({root, blobs, baseTree, baseCommit}) {
  const headCommit = 'b'.repeat(40);
  const nextTree = 'e'.repeat(40);
  const mergeCommit = '9'.repeat(40);
  const state = {ref: null, entries: null, pull: null};
  const diffFiles = () => {
    const prior = new Map(baseTree.map(entry => [entry.path, entry]));
    const files = [];
    for (const entry of state.entries || []) {
      if (entry.type !== 'blob') continue;
      const old = prior.get(entry.path);
      if (!old) files.push({filename: entry.path, status: 'added', sha: entry.sha});
      else if (old.sha !== entry.sha) files.push({filename: entry.path, status: 'modified', sha: entry.sha});
    }
    return files;
  };
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const path = decodeURIComponent(new URL(url).pathname);
    const json = (data, status = 200) => Response.json(data, {status});
    const body = method !== 'GET' && opts.body ? JSON.parse(opts.body) : null;
    if (method === 'GET' && path.startsWith(root + '/git/ref/heads/')) {
      return state.ref ? json({object: {sha: state.ref, type: 'commit'}}) : new Response('{}', {status: 404});
    }
    if (path === root + '/git/refs' && method === 'POST') {
      state.ref = body.sha;
      return json({ref: body.ref, object: {sha: body.sha}}, 201);
    }
    if (path === root + '/git/blobs' && method === 'POST') {
      const bytes = base64Decode(body.content);
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return json({sha}, 201);
    }
    if (path === root + '/git/trees' && method === 'POST') {
      const merged = new Map(baseTree.map(entry => [entry.path, {...entry}]));
      for (const entry of body.tree) merged.set(entry.path, entry);
      state.entries = [...merged.values()];
      return json({sha: nextTree}, 201);
    }
    if (path === root + '/git/commits' && method === 'POST') {
      state.ref = headCommit;
      return json({sha: headCommit}, 201);
    }
    if (method === 'PATCH' && path.startsWith(root + '/git/refs/heads/')) {
      state.ref = body.sha;
      return json({object: {sha: body.sha}});
    }
    if (path === root + '/commits/' + headCommit && method === 'GET') {
      return json({
        sha: headCommit, parents: [{sha: baseCommit}], commit: {tree: {sha: nextTree}}, files: diffFiles()
      });
    }
    if (path === root + '/git/trees/' + nextTree || path.startsWith(root + '/git/trees/' + nextTree + '?')) {
      return json({sha: nextTree, truncated: false, tree: state.entries || []});
    }
    if (path === root + '/pulls' && method === 'GET') return json(state.pull ? [state.pull] : []);
    if (path === root + '/pulls/7' && method === 'GET') return state.pull ? json(state.pull) : new Response('{}', {status: 404});
    if (path === root + '/pulls' && method === 'POST') {
      state.pull = {
        number: 7, state: 'open', html_url: 'https://github.com/tester/esp-willow-studio/pull/7',
        head: {ref: body.head, sha: headCommit, repo: {id: 101}},
        base: {ref: 'main', sha: baseCommit, repo: {id: 101}},
        merged_at: null, merged: false
      };
      return json(state.pull, 201);
    }
    if (path === root + '/pulls/7/merge' && method === 'PUT') {
      if (!state.pull || body.sha !== headCommit) return json({message: 'not mergeable'}, 405);
      state.pull = {...state.pull, state: 'closed', merged: true, merged_at: '2026-11-26T12:00:00Z', merge_commit_sha: mergeCommit};
      return json({merged: true, sha: mergeCommit});
    }
    return null;
  };
}

function fixtureFiles(repo) {
  const root = resolve(repo, 'fixtures/imported-sites/static-single/public');
  const files = [];
  for (const name of readdirSync(root)) {
    const bytes = readFileSync(resolve(root, name));
    if (name.includes('/') || name.includes('..')) continue;
    files.push({path: name, bytes: new Uint8Array(bytes)});
  }
  return files;
}

async function seedImportedEditor(h, repo) {
  const tenant = await connectTenant(h);
  const id = await newPreview(h, tenant, {tagline: 'Example Bakery'});
  if ((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status !== 303) throw new Error('mock editor launch did not approve');
  if ((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id})).status !== 303) throw new Error('mock editor launch did not verify');
  const row = h.sqlite.prepare('SELECT plan_json FROM onboarding_launch_jobs WHERE id=?').get(id);
  const plan = JSON.parse(row.plan_json);
  delete plan.site;
  plan.zip = {id, digest: 'ab'.repeat(32), fileCount: 1, totalBytes: 32};
  h.sqlite.prepare('UPDATE onboarding_launch_jobs SET plan_json=? WHERE id=?').run(JSON.stringify(plan), id);
  const files = fixtureFiles(repo);
  const blobs = new Map();
  const tree = [];
  for (const file of files) {
    const sha = await gitBlobSha(file.bytes);
    blobs.set(sha, file.bytes);
    tree.push({path: 'public/' + file.path, mode: '100644', type: 'blob', sha});
  }
  const commit = 'd'.repeat(40);
  const treeSha = 'c'.repeat(40);
  const previous = globalThis.fetch;
  const root = '/repos/tester/esp-willow-studio';
  const publish = editorPublishMock({root, blobs, baseTree: tree, baseCommit: commit});
  globalThis.fetch = async (url, opts) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const json = data => Response.json(data);
    if (path === root + '/branches/main') return json({commit: {sha: commit, commit: {tree: {sha: treeSha}}}});
    if (path === root + '/git/commits/' + commit) return json({sha: commit, tree: {sha: treeSha}});
    if (path === root + '/git/trees/' + treeSha || path.startsWith(root + '/git/trees/' + treeSha + '?')) {
      return json({sha: treeSha, truncated: false, tree});
    }
    if (path.startsWith(root + '/git/blobs/') && (opts?.method || 'GET') === 'GET') {
      const sha = path.slice((root + '/git/blobs/').length);
      const bytes = blobs.get(sha);
      if (!bytes) return previous(url, opts);
      return json({sha, encoding: 'base64', content: base64Encode(bytes)});
    }
    const published = await publish(url, opts);
    if (published) return published;
    return previous(url, opts);
  };
  return {id, cookie: tenant.cookie};
}

function editorFile(repo, urlPath) {
  const relative = decodeURIComponent(urlPath.slice('/site-editor/'.length).split('?')[0]);
  if (!relative || relative.includes('..') || relative.includes('\\')) return null;
  const root = resolve(repo, 'vendor/launch-and-own-site-editor');
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) return null;
  try { return {file, bytes: readFileSync(file)}; } catch { return null; }
}

function editorType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

export async function startMockServer({repo = fileURLToPath(new URL('..', import.meta.url)), port = 8787, zip = false, editorFixture = false} = {}) {
  const {harness, origin} = await import(pathToFileURL(repo + '/onboarding/worker-test-support.mjs'));
  const h = harness();
  globalThis.fetch = h.fetchFn;
  // Same fake ZIP configuration the Worker tests use; enables the ZIP-first landing copy and upload form.
  if (zip && !editorFixture) Object.assign(h.env, {ZIP_ARTIFACTS: memoryBucket(),
    ZIP_PREVIEW_DOMAIN: 'preview.example.test', ZIP_PREVIEW_KEY: 'cd'.repeat(32)});
  const editorSession = editorFixture ? await seedImportedEditor(h, repo) : null;
  if (editorFixture) Object.assign(h.env, {
    ZIP_ARTIFACTS: memoryBucket(),
    ZIP_PREVIEW_DOMAIN: 'preview.example.test',
    ZIP_PREVIEW_KEY: 'cd'.repeat(32),
    EDITOR_ASSISTANT_PROMPT: 'on'
  });
  const server = http.createServer(async (req, res) => {
    try {
      // Only requests addressed to this local server (blocks DNS rebinding); only same-page origins are trusted.
      const local = ['127.0.0.1', 'localhost'].map(h => h + ':' + server.address().port);
      if (!local.includes(req.headers.host)) { res.writeHead(421, {'content-type': 'text/plain'}); return res.end('Local QA server only'); }
      if (req.method === 'GET' && req.url.startsWith('/site-editor/')) {
        const found = editorFile(repo, req.url);
        if (!found) { res.writeHead(404, {'content-type': 'text/plain'}); return res.end('Not found'); }
        res.writeHead(200, {
          'content-type': editorType(found.file), 'content-security-policy': EDITOR_CSP,
          'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store'
        });
        return res.end(found.bytes);
      }
      if (editorSession && req.method === 'GET' && req.url.split('?')[0] === '/dev/open-editor') {
        res.writeHead(302, {
          location: '/imported-edit?id=' + editorSession.id,
          'set-cookie': editorSession.cookie + '; Path=/; Secure; HttpOnly; SameSite=Lax',
          'cache-control': 'no-store'
        });
        return res.end();
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = {...req.headers};
      delete headers.host;
      if (headers.origin === undefined) delete headers.origin;
      else if (local.some(h => headers.origin === 'http://' + h)) headers.origin = origin; // other origins pass through and fail the Worker's check
      const r = await h.request(req.url, {method: req.method, cookie: req.headers.cookie, headers,
        body: req.method === 'POST' && chunks.length ? Buffer.concat(chunks) : undefined});
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      const loc = r.headers.get('location');
      if (loc) {
        const u = new URL(loc, origin);
        // Mock consent: go straight to the local OAuth callback with the harness's accepted test codes.
        if (u.hostname === 'github.com' && u.pathname.includes('authorize'))
          out.location = '/oauth/github/callback?code=good&state=' + encodeURIComponent(u.searchParams.get('state') || '');
        else if (u.hostname.endsWith('cloudflare.com') && u.searchParams.get('state'))
          out.location = '/oauth/cloudflare/callback?code=valid&state=' + encodeURIComponent(u.searchParams.get('state'));
        else out.location = u.origin === origin ? u.pathname + u.search : loc;
      }
      res.writeHead(r.status, {...out, 'set-cookie': r.headers.getSetCookie()});
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, {'content-type': 'text/plain'});
      res.end(String(e?.stack || e));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const editorFixture = args.includes('--editor');
  const server = await startMockServer({repo: opt('--repo'), port: Number(opt('--port') || 8787), zip: args.includes('--zip'), editorFixture});
  const address = 'http://127.0.0.1:' + server.address().port;
  console.log('Launch & Own onboarding, mocked providers: ' + address + '/');
  if (editorFixture) console.log('Imported site editor: ' + address + '/dev/open-editor');
}
