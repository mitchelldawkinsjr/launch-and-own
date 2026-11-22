import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(pluginRoot, '..', '..');
const canonical = join(repoRoot, 'skills', 'launch-and-own');
const bundled = join(pluginRoot, 'skills', 'launch-and-own');
const skillFiles = ['SKILL.md', 'reference.md', 'examples.md'];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const read = path => readFileSync(path, 'utf8');

test('Claude plugin manifest is skills-only and does not invent MCP tools', () => {
  const manifest = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'launch-and-own');
  assert.match(manifest.description, /instructions-only/i);
  assert.match(manifest.description, /onboard\.360web\.cloud/);
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.commands, undefined);
  for (const key of Object.keys(manifest)) {
    assert.doesNotMatch(key, /mcp/i);
  }
});

test('bundled skill files stay byte-identical to the portable skill', () => {
  for (const name of skillFiles) {
    assert.equal(
      read(join(bundled, name)),
      read(join(canonical, name)),
      name + ' drifted from skills/launch-and-own — run npm run sync:claude-plugin'
    );
  }
  const names = readdirSync(bundled).sort();
  assert.deepEqual(names, skillFiles.slice().sort());
});

test('plugin README forbids marketplace publication and chat-side publish', () => {
  const readme = read(join(pluginRoot, 'README.md'));
  assert.match(readme, /Not\*\* a marketplace listing/i);
  assert.match(readme, /claude --plugin-dir \.\/clients\/claude-plugin/);
  assert.match(readme, /No one-click publish from chat/);
  assert.match(readme, /Issue #43/);
  assert.doesNotMatch(readme, /published to the Claude (marketplace|plugin directory)/i);
});

test('optional claude plugin validate passes when the CLI is installed', () => {
  const which = spawnSync('which', ['claude'], {encoding: 'utf8'});
  if (which.status !== 0) {
    assert.ok(existsSync(join(pluginRoot, '.claude-plugin', 'plugin.json')));
    return;
  }
  const result = spawnSync('claude', ['plugin', 'validate', pluginRoot], {
    encoding: 'utf8',
    timeout: 60_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Validation passed/i);
});
