#!/usr/bin/env node
/**
 * Copy canonical portable skill markdown into the thin Claude Code plugin.
 * Does not invent MCP tools or marketplace manifests.
 */
import {cpSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'skills', 'launch-and-own');
const dest = join(root, 'clients', 'claude-plugin', 'skills', 'launch-and-own');
const files = ['SKILL.md', 'reference.md', 'examples.md'];

mkdirSync(dest, {recursive: true});
for (const name of files) {
  cpSync(join(src, name), join(dest, name));
}

// Drop any stray non-canonical files if a previous sync left them.
for (const name of ['PACKAGING.md', 'skill-contract.test.mjs', 'README.md']) {
  try {
    rmSync(join(dest, name));
  } catch {
    /* absent is fine */
  }
}

console.log('Synced ' + files.length + ' skill files → clients/claude-plugin/skills/launch-and-own/');
