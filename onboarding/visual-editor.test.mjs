import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantPromptMarkup, livePreviewUrl, pagesDevPreviewUrl, publicSitePath, visualEditorMarkup } from './visual-editor.mjs';

test('live preview urls keep the launch id on every asset path', () => {
  assert.equal(livePreviewUrl('/imported-edit-live/', 'index.html', { jobId: 'abc' }), '/imported-edit-live/abc/index.html');
  assert.equal(livePreviewUrl('/imported-edit-live/', 'about/index.html', { jobId: 'abc' }), '/imported-edit-live/abc/about/index.html');
  assert.equal(pagesDevPreviewUrl('willow', 'about/index.html'), 'https://esp-willow-site.pages.dev/about/');
  assert.equal(publicSitePath('index.html'), '/');
});

test('visual editor markup is script-free and lists targets', () => {
  const html = visualEditorMarkup({
    jobId: 'job-1',
    page: 'index.html',
    pages: ['index.html'],
    iframeSrc: livePreviewUrl('/imported-edit-live/', 'index.html', { jobId: 'job-1' }),
    liveSiteSrc: 'https://esp-willow-site.pages.dev/',
    targets: [{ id: 'idx_text_ab', kind: 'text', kindLabel: 'Visible text', relativePath: 'index.html', find: 'Hello', label: 'Hello' }],
    picked: null,
    csrf: 'a'.repeat(32),
    previewAction: '/imported-edit-preview',
    editorPath: '/imported-edit'
  });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /ve-targets/);
  assert.match(html, /\/site-editor\/index\.html\?id=job-1&amp;page=index\.html#csrf=/);
  assert.doesNotMatch(html, /sandbox=/);
  assert.match(html, /Advanced: one exact text change/);
  assert.match(html, /Preview this edit/);
  const placed = visualEditorMarkup({
    jobId: 'job-1', page: 'index.html', pages: ['index.html'],
    iframeSrc: livePreviewUrl('/imported-edit-live/', 'index.html', { jobId: 'job-1' }),
    targets: [], picked: null, csrf: 'a'.repeat(32),
    previewAction: '/imported-edit-preview', editorPath: '/imported-edit',
    aiBlock: assistantPromptMarkup({ csrf: 'a'.repeat(32), action: '/preview' })
  });
  const title = placed.indexOf('Edit this page');
  const ask = placed.indexOf('Ask your AI assistant');
  const frame = placed.indexOf('iframe title="Visual page editor"');
  const advanced = placed.indexOf('Advanced: one exact text change');
  assert.ok(title >= 0 && title < ask && ask < frame && frame < advanced);
});