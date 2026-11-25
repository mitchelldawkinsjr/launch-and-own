import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { base64Encode, gitBlobSha } from './bytes.mjs';
import { inspectSite, isColor } from './intelligence.mjs';
import { readCurrentRevision } from './revision.mjs';

const text = (path, value) => ({ path, bytes: new TextEncoder().encode(value) });
const page = body => `<!doctype html><html><body>${body}</body></html>`;

test('imported modules stay off the one-page renderer and do not execute commands', () => {
  for (const name of readdirSync(new URL('.', import.meta.url))) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /render-site|site\.json|child_process|execSync|\bspawn\(/);
  }
});

test('a custom-property value is one CSS color', () => {
  for (const color of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'rebeccapurple', 'Transparent', 'hsl(12, 48%, 39%)', 'hsl(120deg 50% 40% / 50%)', 'rgb(255 75 58 / 80%)', 'oklch(0.45 0.08 160)', 'oklch(62.7% 0.19 149.2 / 0.8)']) {
    assert.equal(isColor(color), true, color);
  }
  for (const color of ['expression(alert(1))', 'url(#112233)', 'cream', '#12', '#12345', 'rgb(255, 0%, 0)', 'oklch(0.45 0.08 160) red', 'color-mix(in srgb, red 50%, blue)', 'var(--ink)', 'red; }']) {
    assert.equal(isColor(color), false, color);
  }
});

test('classifies static, multi-page, compiled, and unsupported sites without rewriting bytes', async () => {
  const html = text('index.html', page('<h1>Willow Studio</h1>'));
  const css = text('styles.css', 'h1 { color: #1f4b3a; }\n');
  const png = { path: 'photo.png', bytes: Uint8Array.of(1, 2, 3, 4) };
  const script = text('script.js', 'console.log("ready");\n');
  const before = html.bytes.slice();
  const site = await inspectSite([html, css, png, script]);
  assert.deepEqual(html.bytes, before);
  assert.equal(site.v, 1);
  assert.equal(site.root, 'public/');
  assert.equal(site.classification, 'static');
  assert.equal(site.importable, true);
  assert.deepEqual(site.reasons, ['has_index_html']);
  const pageFile = site.files.find(file => file.path === 'public/index.html');
  assert.deepEqual(pageFile.editable, ['text', 'link', 'business_info']);
  assert.equal(pageFile.type, 'html');
  assert.equal(pageFile.readOnlyReason, null);
  assert.equal(pageFile.blobSha, await gitBlobSha(html.bytes));
  assert.deepEqual(site.files.find(file => file.path === 'public/styles.css').editable, []);
  const custom = await inspectSite([html, text('brand.css', ':root { --ink: #1f4b3a; }\n')]);
  assert.deepEqual(custom.files.find(file => file.path === 'public/brand.css').editable, ['css_color']);
  assert.deepEqual(site.files.find(file => file.path === 'public/script.js').editable, []);
  assert.equal(site.files.find(file => file.path === 'public/script.js').type, 'js');
  assert.equal(site.files.find(file => file.path === 'public/photo.png').type, 'image');
  assert.deepEqual(site.files.find(file => file.path === 'public/photo.png').editable, []);
  assert.equal(site.serveReady, true);

  const missing = await inspectSite([
    text('index.html', page('<script src="config.js"></script><h1>Willow Studio</h1>')),
    css
  ]);
  assert.equal(missing.classification, 'static');
  assert.equal(missing.serveReady, false);
  const directory = await inspectSite([
    text('index.html', page('<a href="/about/">About</a>')),
    text('about/index.html', page('<h1>About</h1>'))
  ]);
  assert.equal(directory.serveReady, true);
  assert.equal(directory.reasons.includes('missing_local_dependency'), false);
  const absent = await inspectSite([text('index.html', page('<a href="/missing/">Missing</a>'))]);
  assert.equal(absent.serveReady, false);
  assert.deepEqual(missing.reasons, ['has_index_html', 'missing_local_dependency']);
  const font = await inspectSite([
    text('index.html', page('<h1>Willow Studio</h1>')),
    text('styles.css', '@import "fonts.css";\nh1 { color: #1f4b3a; background: url("photo.png"); }\n')
  ]);
  assert.equal(font.classification, 'static');
  assert.ok(font.reasons.includes('missing_local_dependency'));

  const moduleSource = await inspectSite([
    text('index.html', page('<script type="module" src="app.js"></script><script src="config.js"></script>')),
    text('app.js', 'import React from "react"\n')
  ]);
  assert.equal(moduleSource.classification, 'source_project');
  assert.deepEqual(moduleSource.reasons, ['bare_import', 'has_index_html', 'missing_local_dependency', 'source_project']);
  assert.equal(moduleSource.files.find(file => file.path === 'public/app.js').readOnlyReason, 'bare_import');
  assert.equal(moduleSource.files.every(file => file.editable.length === 0), true);

  const multi = await inspectSite([html, text('about.html', page('<h1>About</h1>')), css]);
  assert.equal(multi.classification, 'static_multipage');
  assert.ok(multi.files.some(file => file.editable.includes('text')));

  const bundle = await inspectSite([
    text('index.html', page('<script src="assets/index-deadbeef.js"></script>')),
    text('assets/index-deadbeef.js', 'function(){' + 'var a=1;'.repeat(80) + '}')
  ]);
  assert.equal(bundle.classification, 'compiled_bundle');
  assert.ok(bundle.reasons.includes('minified_js_bundle'));
  assert.equal(bundle.files.every(file => file.editable.length === 0), true);

  const source = await inspectSite([
    text('package.json', '{"name":"site"}\n'),
    text('vite.config.js', 'export default {}\n'),
    text('src/App.jsx', 'export function App(){ return null }\n'),
    text('index.html', page('<div id="root"></div>'))
  ]);
  assert.equal(source.classification, 'source_project');
  assert.equal(source.importable, false);
  assert.equal(source.files.find(file => file.path === 'public/package.json').readOnlyReason, 'config_file');
  assert.equal(source.files.find(file => file.path === 'public/src/App.jsx').readOnlyReason, 'unsupported_file_type');
  assert.ok(source.reasons.includes('unsupported_file_type'));

  const hosted = await inspectSite([html, text('wrangler.toml', 'name = "site"\n'), text('.env', 'TOKEN=1\n')]);
  assert.equal(hosted.classification, 'source_project');
  assert.equal(hosted.importable, false);
  assert.equal(hosted.files.find(file => file.path === 'public/wrangler.toml').readOnlyReason, 'unsupported_file_type');
  const linked = await inspectSite([
    text('index.html', page('<a href="https://willow.example">Visit</a>'))
  ]);
  assert.ok(linked.reasons.includes('external_dependency'));
  assert.equal(linked.serveReady, true);
});

test('matches the shared imported-site fixture inventories', async () => {
  const root = new URL('../fixtures/imported-sites/', import.meta.url);
  const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'research');
  for (const entry of names) {
    const dir = new URL(entry.name + '/', root);
    const expected = JSON.parse(readFileSync(new URL('expected-inventory.json', dir), 'utf8'));
    const files = [];
    const walk = (url, prefix = '') => {
      for (const child of readdirSync(url, { withFileTypes: true })) {
        const rel = prefix + child.name;
        if (child.isDirectory()) walk(new URL(child.name + '/', url), rel + '/');
        else files.push({ path: rel, bytes: new Uint8Array(readFileSync(new URL(child.name, url))) });
      }
    };
    walk(new URL('public/', dir));
    const actual = await inspectSite(files);
    assert.deepEqual({
      v: actual.v,
      classification: actual.classification,
      importable: actual.importable,
      serveReady: actual.serveReady,
      reasons: actual.reasons,
      files: actual.files.map(({ path, bytes, type, editable, readOnlyReason }) => ({ path, bytes, type, editable, readOnlyReason }))
    }, expected, entry.name);
  }
});

test('reads the current Git revision on every call and ignores a supplied SHA', async () => {
  const bytes = new TextEncoder().encode(page('<h1>Willow Studio</h1>'));
  const sha = await gitBlobSha(bytes);
  let reads = 0;
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/branches/main')) reads += 1;
    if (path === '/user') return Response.json({ login: 'tester', id: 42 });
    if (path === '/repos/tester/esp-willow') return Response.json({
      id: 101, name: 'esp-willow', private: true, default_branch: 'main',
      description: 'Launch & Own managed site: willow', owner: { login: 'tester', id: 42 }
    });
    if (path.endsWith('/branches/main')) return Response.json({ commit: { sha: 'a'.repeat(40) } });
    if (path.endsWith('/git/commits/' + 'a'.repeat(40))) return Response.json({ sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } });
    if (path.endsWith('/git/trees/' + 'b'.repeat(40))) return Response.json({
      truncated: false,
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40) },
        { path: 'public/index.html', mode: '100644', type: 'blob', sha }
      ]
    });
    if (path.endsWith('/git/blobs/' + sha)) return Response.json({ sha, encoding: 'base64', content: base64Encode(bytes) });
    throw new Error('unexpected ' + path);
  };
  const input = { owner: 'tester', repo: 'esp-willow', token: 'ghs_test', fetchFn };
  const first = await readCurrentRevision(input);
  const second = await readCurrentRevision(input);
  assert.equal(reads, 2);
  assert.equal(first.commitSha, 'a'.repeat(40));
  assert.equal(second.commitSha, first.commitSha);
  assert.deepEqual(first.files[0].bytes, bytes);
  assert.equal(first.files[0].path, 'index.html');
  let called = false;
  await assert.rejects(readCurrentRevision({ ...input, commitSha: 'd'.repeat(40), fetchFn: () => { called = true; } }), /revision-must-be-read/);
  assert.equal(called, false);
});
