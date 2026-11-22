import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  MAX_FILE_BYTES,
  MAX_SITE_BYTES,
  MAX_SITE_FILES,
  MAX_ZIP_BYTES
} from '../../onboarding/website-zip.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(root, name), 'utf8');
const skill = read('SKILL.md');
const reference = read('reference.md');
const examples = read('examples.md');
const packaging = read('PACKAGING.md');
const all = [skill, reference, examples, packaging].join('\n');

test('skill frontmatter names the portable launch-and-own skill', () => {
  assert.match(skill, /^---\nname: launch-and-own\n/m);
  assert.match(skill, /^description: >-/m);
});

test('required phase vocabulary is present and ordered as a contract', () => {
  for (const phase of ['Prepare', 'Exact preview', 'Separate approval', 'Publish', 'Verify live']) {
    assert.match(skill, new RegExp(phase));
  }
  assert.match(skill, /Chat instructions alone authorize \*\*prepare\*\* only/i);
});

test('never coaches token-in-chat or secret pasting', () => {
  assert.match(all, /Never\*\* ask for, accept, store, or echo GitHub\/Cloudflare API tokens/i);
  assert.doesNotMatch(all, /paste (your )?(api )?token/i);
  assert.doesNotMatch(all, /send (me )?your (github|cloudflare).*(token|password|secret)/i);
});

test('never authorizes publishing without separate customer approval', () => {
  assert.match(skill, /separate (browser )?approval/i);
  assert.match(skill, /Approve and create website/);
  assert.doesNotMatch(skill, /publish (now|immediately) from chat/i);
  assert.doesNotMatch(all, /one-click publish through ChatGPT or Claude/i);
});

test('forbids inventing live outcomes, OAuth state, or fake URLs', () => {
  assert.match(skill, /Never\*\* invent OAuth state, approval digests, commit SHAs/i);
  assert.match(examples, /\*\*Do not:\*\* invent `esp-…pages\.dev` URLs/i);
  assert.match(skill, /do not invent tool calls or action URLs/i);
});

test('defaults to not sharing customer content', () => {
  assert.match(skill, /Never\*\* share the customer.s private business copy/i);
  assert.match(examples, /Do not paste real customer content/i);
});

test('browser handoff uses the approved onboard origin', () => {
  assert.match(skill, /https:\/\/onboard\.360web\.cloud/);
  assert.match(reference, /https:\/\/onboard\.360web\.cloud/);
  assert.doesNotMatch(all, /onboard\.mitchelldawkins\.com/);
});

test('ZIP limits in reference stay aligned with website-zip.mjs', () => {
  assert.match(reference, new RegExp(String(MAX_ZIP_BYTES / (1024 * 1024)) + ' MiB'));
  assert.match(reference, new RegExp(String(MAX_SITE_BYTES / (1024 * 1024)) + ' MiB'));
  assert.match(reference, new RegExp(String(MAX_FILE_BYTES / (1024 * 1024)) + ' MiB'));
  assert.match(reference, new RegExp(String(MAX_SITE_FILES)));
  assert.match(reference, /index\.html/);
});

test('hosted ZIP browser beta is supported while MCP publish remains future', () => {
  assert.match(skill, /Hosted static ZIP upload[\s\S]*\*\*Available \(browser beta; owner-tested\)\*\*/);
  assert.match(skill, /Agent MCP tools:[\s\S]*\*\*Future\*\*/);
  assert.match(skill, /Browser onboarding[\s\S]*\*\*Available\*\*/);
  assert.match(packaging, /elite-site-pipeline[\s\S]*\*\*not\*\* a production tool-backed publisher/i);
});

test('examples cover the four required scenarios', () => {
  assert.match(examples, /Build a new one-page site/);
  assert.match(examples, /existing static ZIP/);
  assert.match(examples, /Update my verified site/);
  assert.match(examples, /needs_reauthorization/);
});

test('packaging points at this canonical path without inventing store listings', () => {
  assert.match(packaging, /skills\/launch-and-own/);
  assert.match(packaging, /clients\/claude-plugin/);
  assert.match(packaging, /marketplace or Anthropic directory listing is \*\*not\*\* authorized/i);
  assert.match(packaging, /Do \*\*not\*\* invent Claude tool names/i);
});

test('ZIP examples and reference reflect owner-tested beta without chat-side publish', () => {
  assert.match(examples, /hosted browser beta/i);
  assert.match(reference, /five public file digests matching the uploaded ZIP/i);
  assert.match(skill, /private ticket-protected exact preview/i);
  assert.match(reference, /95 ms Worker CPU/i);
  assert.doesNotMatch(all, /ZIP release is gated|Future \/ gated|hosted production ZIP.*remains gated/i);
  assert.match(skill, /Chat instructions alone authorize \*\*prepare\*\* only/);
});

test('agent-generated HTML is packaged into the real ZIP handoff rather than recreated manually', () => {
  assert.match(skill, /Default handoff for agent-generated files: package the validated deployable directory as a static ZIP/i);
  assert.match(skill, /Do not send an agent-generated HTML site to the manual one-page editor/i);
  assert.match(skill, /If the agent.s authorized tools can create an attachment/i);
  assert.match(skill, /never claim a ZIP was created unless it exists/i);
  assert.match(examples, /Package the generated site as a static ZIP/i);
  assert.match(examples, /Upload a built website[\s\S]*upload the ZIP/i);
  assert.match(reference, /Do \*\*not\*\* redirect the customer to re-enter copy/i);
});
