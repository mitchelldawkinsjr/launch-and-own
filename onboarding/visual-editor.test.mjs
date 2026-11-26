import test from 'node:test';
import assert from 'node:assert/strict';
import { livePreviewUrl, visualEditorMarkup } from './visual-editor.mjs';

test('visual editor markup is script-free and lists targets', () => {
  const html = visualEditorMarkup({
    jobId: 'job-1',
    page: 'index.html',
    pages: ['index.html'],
    iframeSrc: livePreviewUrl('/imported-edit-live/', 'index.html', 'id=job-1'),
    targets: [{ id: 'idx_text_ab', kind: 'text', kindLabel: 'Visible text', relativePath: 'index.html', find: 'Hello', label: 'Hello' }],
    picked: null,
    csrf: 'a'.repeat(32),
    previewAction: '/imported-edit-preview',
    editorPath: '/imported-edit'
  });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /ve-targets/);
  assert.match(html, /sandbox="allow-same-origin"/);
  assert.match(html, /Preview this edit/);
});