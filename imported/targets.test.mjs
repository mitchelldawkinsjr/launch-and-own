import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { inspectSite } from './intelligence.mjs';
import { editablePages, listEditTargets, pickEditTarget } from './targets.mjs';

const text = (path, value) => ({ path, bytes: new TextEncoder().encode(value) });

test('lists unique inventory targets on static-single fixture', async () => {
  const root = new URL('../fixtures/imported-sites/static-single/public/', import.meta.url);
  const files = [
    text('index.html', readFileSync(new URL('index.html', root), 'utf8')),
    text('style.css', readFileSync(new URL('style.css', root), 'utf8'))
  ];
  const inspection = await inspectSite(files);
  const targets = listEditTargets(files, inspection);
  assert.ok(targets.some(t => t.kind === 'text' && t.find === 'Saturday: 9 AM-2 PM'));
  assert.ok(targets.some(t => t.kind === 'text' && t.find === 'Contact us'));
  assert.ok(targets.some(t => t.kind === 'link' && t.find.startsWith('mailto:')));
  assert.equal(editablePages(inspection).join(','), 'index.html');
  const picked = pickEditTarget(targets, targets[0].id);
  assert.equal(picked?.find, targets[0].find);
});

test('splits targets by page for static-multipage', async () => {
  const base = new URL('../fixtures/imported-sites/static-multipage/public/', import.meta.url);
  const files = [
    text('index.html', readFileSync(new URL('index.html', base), 'utf8')),
    text('about/index.html', readFileSync(new URL('about/index.html', base), 'utf8'))
  ];
  const inspection = await inspectSite(files);
  const pages = editablePages(inspection);
  assert.deepEqual(pages, ['about/index.html', 'index.html']);
  const onHome = listEditTargets(files, inspection).filter(t => t.relativePath === 'index.html');
  const onAbout = listEditTargets(files, inspection).filter(t => t.relativePath === 'about/index.html');
  assert.ok(onHome.length);
  assert.ok(onAbout.length);
});