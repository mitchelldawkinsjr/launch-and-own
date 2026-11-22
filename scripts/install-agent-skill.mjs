#!/usr/bin/env node
/** Copy the instructions-only portable skill into a local Codex/Cursor project. */
import {createHash} from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SOURCE = fileURLToPath(new URL('../skills/launch-and-own/', import.meta.url));
const FILES = Object.freeze([
  'SKILL.md', 'reference.md', 'examples.md', 'PACKAGING.md', 'INSTALL_QA.md'
]);
const CLIENT_DIRS = Object.freeze({codex: '.agents', cursor: '.cursor'});
const usage = () => [
  'Install the instructions-only Launch & Own skill in an existing project.',
  'Usage: node scripts/install-agent-skill.mjs --client codex|cursor --target PATH [--dry-run|--check]',
  '--dry-run: display destination without writing; --check: verify an existing installation',
  'No credentials, API connections or hosted publishing are involved.'
].join('\n');

function parseArgs(args) {
  const out = {client: null, target: null, dryRun: false, check: false, help: false};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--client' || arg === '--target') {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw Error('Missing value for ' + arg);
      const field = arg === '--client' ? 'client' : 'target';
      if (out[field] !== null) throw Error('Duplicate ' + arg);
      out[field] = args[++i];
    } else if (arg === '--dry-run' || arg === '--check') {
      const field = arg === '--dry-run' ? 'dryRun' : 'check';
      if (out[field]) throw Error('Duplicate ' + arg);
      out[field] = true;
    } else {
      throw Error('Unknown argument: ' + arg);
    }
  }
  if (out.help) return out;
  if (!Object.hasOwn(CLIENT_DIRS, out.client))
    throw Error('Choose --client codex or --client cursor');
  if (!out.target) throw Error('Provide --target with an existing project path');
  if (out.dryRun && out.check) throw Error('--dry-run and --check are exclusive');
  return out;
}

function directoryOrAbsent(path) {
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw Error('Unsafe non-directory or symbolic link: ' + path);
  return true;
}

function verifyInstalled(destination, expected) {
  if (readdirSync(destination).sort().join('\0') !== [...expected.keys()].sort().join('\0'))
    throw Error('Existing skill has extra or missing files; refusing to overwrite: ' + destination);
  for (const [name, bytes] of expected) {
    const file = join(destination, name);
    if (!lstatSync(file).isFile() || !readFileSync(file).equals(bytes))
      throw Error('Existing skill differs from canonical source; refusing to overwrite: ' + file);
  }
}

function bundleDigest(expected) {
  const hash = createHash('sha256');
  for (const [name, bytes] of expected) {
    hash.update(name + '\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function installSkill(args) {
  const options = parseArgs(args);
  if (options.help) return usage();
  const project = resolve(options.target);
  if (!directoryOrAbsent(project))
    throw Error('Project directory does not exist: ' + project);
  const root = realpathSync(project);
  const clientHome = join(root, CLIENT_DIRS[options.client]);
  const skillsHome = join(clientHome, 'skills');
  const destination = join(skillsHome, 'launch-and-own');
  // Do not follow project-level config symlinks outside the chosen project.
  directoryOrAbsent(clientHome);
  directoryOrAbsent(skillsHome);
  const expected = new Map(FILES.map(name => [name, readFileSync(join(SOURCE, name))]));
  const sha = bundleDigest(expected);
  if (directoryOrAbsent(destination)) {
    verifyInstalled(destination, expected);
    return 'Verified existing ' + options.client + ' skill: ' + destination + '\nSHA-256 bundle: ' + sha;
  }
  if (options.check) throw Error('Skill is not installed: ' + destination);
  if (options.dryRun)
    return 'Would install ' + options.client + ' skill at: ' + destination + '\nSHA-256 bundle: ' + sha;

  mkdirSync(skillsHome, {recursive: true});
  const staged = mkdtempSync(join(skillsHome, '.launch-and-own-'));
  try {
    for (const [name, bytes] of expected) writeFileSync(join(staged, name), bytes, {flag: 'wx'});
    if (existsSync(destination)) throw Error('Skill appeared during installation: ' + destination);
    renameSync(staged, destination);
  } finally {
    if (existsSync(staged)) rmSync(staged, {recursive: true, force: true});
  }
  return 'Installed instructions-only ' + options.client + ' skill: ' + destination +
    '\nSHA-256 bundle: ' + sha +
    '\nManual real-client checks remain necessary; this does not publish a website.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(installSkill(process.argv.slice(2)));
  } catch (error) {
    console.error('Skill installation failed: ' + error.message + '\n' + usage());
    process.exitCode = 1;
  }
}
