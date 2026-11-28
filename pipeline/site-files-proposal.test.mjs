import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSiteFilesProposal as build } from './site-files-proposal.mjs';

const paths = ['README.md', 'public/index.html', 'public/about/index.html', 'public/menu.html', 'public/404.html',
  'public/.well-known/x.html', 'public/style.css'];

test('SEO adds robots.txt and a sitemap of the site\'s own pages only', async () => {
  const r = await build({kind: 'seo', paths, origin: 'https://example.com'});
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map(f => f.path), ['public/robots.txt', 'public/sitemap.xml']);
  assert.match(r.files[0].content, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
  const locs = [...r.files[1].content.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, ['https://example.com/', 'https://example.com/about/', 'https://example.com/menu']);
  assert.match(r.digest, /^[a-f0-9]{64}$/);
  assert.equal((await build({kind: 'seo', paths, origin: 'https://example.com'})).digest, r.digest, 'deterministic');
});

test('redirects add one _redirects file with 301 lines', async () => {
  const r = await build({kind: 'redirects', paths, payload: {wwwMode: 'none', pathRules: [{from: '/old', to: '/about/'}]}});
  assert.deepEqual(r.files, [{path: 'public/_redirects', content: '/old /about/ 301\n'}]);
});

test('SEO proposes only missing files and reports an already complete set', async () => {
  const origin = 'https://example.com';
  const withRobots = await build({kind: 'seo', paths: [...paths, 'public/Robots.txt'], origin});
  assert.deepEqual(withRobots.existingFiles, ['public/Robots.txt']);
  assert.deepEqual(withRobots.files.map(f => f.path), ['public/sitemap.xml']);
  const withSitemap = await build({kind: 'seo', paths: ['public/Sitemap.xml'], origin});
  assert.deepEqual(withSitemap.existingFiles, ['public/Sitemap.xml']);
  assert.deepEqual(withSitemap.files.map(f => f.path), ['public/robots.txt']);
  assert.match(withSitemap.files[0].content, /Sitemap: https:\/\/example\.com\/Sitemap\.xml/);
  assert.deepEqual(await build({kind: 'seo', paths: ['public/robots.txt', 'public/sitemap.xml'], origin}),
    {ok: false, reason: 'already_present', existingFiles: ['public/robots.txt', 'public/sitemap.xml']});
});

test('never replaces an existing file and refuses unsafe input', async () => {
  for (const [input, reason] of [
    [{kind: 'redirects', paths: [...paths, 'public/_redirects'], payload: {wwwMode: 'none', pathRules: [{from: '/a', to: '/b'}]}}, 'file_exists'],
    [{kind: 'seo', paths, origin: 'http://example.com'}, 'origin_unverified'],
    [{kind: 'seo', paths: ['public/a.css'], origin: 'https://example.com'}, 'no_pages'],
    [{kind: 'redirects', paths, payload: {wwwMode: 'www_to_apex', pathRules: [{from: '/a', to: '/b'}]}}, 'www_redirect_unsupported'],
    [{kind: 'redirects', paths, payload: {wwwMode: 'none', pathRules: [{from: '/a', to: 'https://evil.example/'}]}}, 'unsafe_rule'],
    [{kind: 'redirects', paths, payload: {wwwMode: 'none', pathRules: [{from: '/a\n/* https://evil 302', to: '/b'}]}}, 'unsafe_rule'],
    [{kind: 'redirects', paths, payload: {wwwMode: 'none', pathRules: [{from: '/a', to: '//evil.example'}]}}, 'unsafe_rule'],
    [{kind: 'redirects', paths, payload: {wwwMode: 'none', pathRules: []}}, 'no_rules'],
    [{kind: 'domain', paths}, 'unsupported_kind']
  ]) assert.deepEqual(await build(input), {ok: false, reason}, JSON.stringify(input).slice(0, 100));
});
