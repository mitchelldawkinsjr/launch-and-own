import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const command = fileURLToPath(new URL('./install-agent-skill.mjs', import.meta.url));
const source = fileURLToPath(new URL('../skills/launch-and-own/', import.meta.url));
const files = ['SKILL.md', 'reference.md', 'examples.md', 'PACKAGING.md', 'INSTALL_QA.md'];
const run = (project, client, extra = []) =>
  spawnSync(process.execPath, [command, '--client', client, '--target', project, ...extra],
    {encoding: 'utf8'});

function withProject(fn) {
  const project = mkdtempSync(join(tmpdir(), 'launch-own-skill-'));
  try {fn(project);} finally {rmSync(project, {recursive: true, force: true});}
}

for (const [client, home] of [['codex', '.agents'], ['cursor', '.cursor']]) {
  test(client + ': canonical files install and can be checked repeatedly', () => withProject(project => {
    const first = run(project, client);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /instructions-only/);
    const destination = join(project, home, 'skills', 'launch-and-own');
    assert.deepEqual(readdirSync(destination).sort(), files.slice().sort());
    for (const name of files) {
      assert.ok(lstatSync(join(destination, name)).isFile());
      assert.deepEqual(readFileSync(join(destination, name)), readFileSync(join(source, name)));
    }
    const check = run(project, client, ['--check']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /Verified existing/);
    assert.equal(run(project, client).status, 0, 'reinstall should verify, never overwrite');
    assert.match(readFileSync(join(destination, 'SKILL.md'), 'utf8'),
      /Chat instructions alone authorize \*\*prepare\*\* only/i);
  }));

  test(client + ': dry-run and absent check make no modifications', () => withProject(project => {
    const homePath = join(project, home);
    const dry = run(project, client, ['--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would install/);
    assert.equal(existsSync(homePath), false);
    const check = run(project, client, ['--check']);
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /not installed/);
    assert.equal(existsSync(homePath), false);
  }));

  test(client + ': modified or extra files are never overwritten', () => withProject(project => {
    assert.equal(run(project, client).status, 0);
    const destination = join(project, home, 'skills', 'launch-and-own');
    writeFileSync(join(destination, 'SKILL.md'), 'CUSTOM CONTENT');
    const changed = run(project, client);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /refusing to overwrite/i);
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'CUSTOM CONTENT');
    writeFileSync(join(destination, 'SKILL.md'), readFileSync(join(source, 'SKILL.md')));
    writeFileSync(join(destination, 'customer-notes.md'), 'LOCAL FILE');
    const extra = run(project, client, ['--check']);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /extra or missing files/);
  }));

  test(client + ': symlinked config directory is rejected', () => withProject(project => {
    const outside = mkdtempSync(join(tmpdir(), 'launch-own-outside-'));
    try {
      symlinkSync(outside, join(project, home), 'dir');
      const result = run(project, client);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic link/);
      assert.equal(existsSync(join(outside, 'skills')), false);
    } finally {
      rmSync(outside, {recursive: true, force: true});
    }
  }));
}

test('unknown clients, nonexistent projects and conflicting flags fail closed', () => withProject(project => {
  assert.notEqual(run(project, 'claude').status, 0);
  assert.notEqual(run(project, 'codex', ['--dry-run', '--check']).status, 0);
  const absent = run(join(project, 'missing'), 'cursor');
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /does not exist/);
}));
