#!/usr/bin/env node
/**
 * Vendor the site editor's third-party libraries so owner admin pages load no CDN code (ADR-005).
 * Installs exact npm versions into a temp dir (--ignore-scripts), bundles them with esbuild code splitting
 * (one shared @codemirror/state instance), and writes vendor/launch-and-own-site-editor/lib/ + LIBS.json.
 * Re-run only to upgrade a pinned version, and review the diff.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINS = {
  codemirror: '6.0.1', '@codemirror/lang-html': '6.4.9', '@codemirror/theme-one-dark': '6.1.2',
  '@codemirror/state': '6.4.1', '@codemirror/view': '6.26.3', diff: '5.2.0', 'isomorphic-git': '1.27.2',
  lucide: '0.460.0', esbuild: '0.24.0', buffer: '6.0.3' // buffer: browser polyfill isomorphic-git needs (esm.sh ?bundle did the same)
};
const ENTRIES = ['codemirror', '@codemirror/lang-html', '@codemirror/theme-one-dark', '@codemirror/state', '@codemirror/view', 'diff', 'isomorphic-git'];
const fileFor = spec => spec.replace(/^@/, '').replace(/\//g, '-');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor/launch-and-own-site-editor/lib');
const work = mkdtempSync(join(tmpdir(), 'lo-editor-libs-'));
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...Object.entries(PINS).map(([n, v]) => n + '@' + v)], { cwd: work, stdio: 'inherit' });
  mkdirSync(join(work, 'entries'));
  for (const spec of ENTRIES) writeFileSync(join(work, 'entries', fileFor(spec) + '.js'), 'export * from ' + JSON.stringify(spec) + ';\n');
  writeFileSync(join(work, 'buffer-shim.js'), "export { Buffer } from 'buffer';\n");
  const { build } = await import(join(work, 'node_modules/esbuild/lib/main.js'));
  rmSync(out, { recursive: true, force: true });
  await build({
    absWorkingDir: work, entryPoints: ENTRIES.map(s => 'entries/' + fileFor(s) + '.js'), outdir: out, bundle: true, splitting: true,
    format: 'esm', minify: true, platform: 'browser', target: 'es2020', chunkNames: 'chunk-[hash]', legalComments: 'eof', inject: ['buffer-shim.js']
  });
  cpSync(join(work, 'node_modules/lucide/dist/umd/lucide.min.js'), join(out, 'lucide.min.js'));
  const files = Object.fromEntries(readdirSync(out).sort().map(f => [f, createHash('sha256').update(readFileSync(join(out, f))).digest('hex')]));
  writeFileSync(join(out, 'LIBS.json'), JSON.stringify({ pins: PINS, files }, null, 2) + '\n');
  console.log('Vendored', Object.keys(files).length, 'files into', out);
} finally {
  rmSync(work, { recursive: true, force: true });
}
