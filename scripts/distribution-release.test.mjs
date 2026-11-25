import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDistributionMatrix, loadDistributionMatrix,
  renderDistributionMatrix, validateDistributionMatrix
} from '../distribution/release-gates.mjs';

const fresh = () => structuredClone(loadDistributionMatrix());
const rejects = (change, message) => {
  const matrix = fresh();
  change(matrix);
  assert.match(validateDistributionMatrix(matrix).join('\n'), message);
  assert.throws(() => assertDistributionMatrix(matrix), /Distribution release gates failed/);
};

test('checked-in matrix is valid and owner beta is not independent acceptance', () => {
  const matrix = assertDistributionMatrix(fresh());
  assert.equal(matrix.surfaces.browser_manual.access, 'hosted_beta');
  assert.equal(matrix.surfaces.browser_manual.verification, 'owner_live');
  assert.equal(matrix.surfaces.browser_zip.access, 'hosted_beta');
  assert.equal(matrix.surfaces.browser_zip.verification, 'owner_live');
  assert.equal(matrix.surfaces.site_updates.access, 'hosted_beta');
  assert.equal(matrix.surfaces.site_updates.verification, 'owner_live', 'owner-live only, not independent acceptance');
  assert.equal(matrix.surfaces.chatgpt_connector.access, 'not_available');
  assert.equal(matrix.surfaces.claude_plugin.access, 'not_available');
  assert.equal(matrix.surfaces.shared_mcp_api.access, 'not_available');
  assert.equal(matrix.surfaces.portable_skill.implementation, 'merged');
  assert.equal(matrix.surfaces.portable_skill.access, 'instructions_only');
  assert.equal(matrix.surfaces.claude_plugin.implementation, 'merged');
  assert.equal(matrix.surfaces.shared_mcp_api.implementation, 'deployed');
  assert.equal(matrix.surfaces.chatgpt_connector.implementation, 'merged');
  const report = renderDistributionMatrix(matrix);
  assert.match(report, /Browser: manual one-page creation \| deployed \| hosted_beta \| owner_live/);
  assert.match(report, /Browser: static ZIP upload \| deployed \| hosted_beta \| owner_live/);
  assert.match(report, /Portable agent skill \(instructions only\) \| merged \| instructions_only \| ci_only/);
  assert.match(report, /Claude Code plugin \(instructions-only local packaging\) \| merged \| not_available \| ci_only/);
  assert.match(report, /Shared authenticated MCP\/API \| deployed \| not_available \| ci_only/);
  assert.match(report, /ChatGPT integration with publishing tools \| merged \| not_available \| ci_only/);
});

test('PRs, merged ZIPs, and local rehearsals cannot be advertised as hosted', () => {
  rejects(m => {
    m.surfaces.site_updates.implementation = 'merged';
    m.surfaces.site_updates.access = 'hosted_beta';
  }, /PR or merged code does not constitute a hosted release/);
  rejects(m => { m.surfaces.site_updates.verification = 'ci_only'; },
    /hosted beta claim requires observed owner-live/);
  rejects(m => { m.surfaces.browser_zip.implementation = 'merged'; m.surfaces.browser_zip.access = 'public'; }, /code does not constitute a hosted release/);
});

test('owner-only proof cannot promote a feature to independent or public', () => {
  rejects(m => { m.surfaces.browser_manual.access = 'external_beta'; }, /independent consenting-user QA/);
  rejects(m => { m.surfaces.browser_manual.access = 'public'; }, /independent consenting-user QA/);
});

test('public release requires separately evidenced owner approval', () => {
  rejects(m => {
    m.surfaces.browser_manual.verification = 'independent_live';
    m.surfaces.browser_manual.access = 'public';
  }, /documented explicit owner approval/);
});

test('connected Claude/ChatGPT clients require accessible shared backend', () => {
  rejects(m => {
    m.surfaces.claude_plugin = {
      ...m.surfaces.claude_plugin,
      implementation: 'deployed', access: 'hosted_beta', verification: 'owner_live'
    };
  }, /connected client cannot ship without a deployed, accessible shared MCP\/API/);
});

test('human approval, tenant identity, provider credential privacy and SHA proof stay mandatory', () => {
  rejects(m => { m.ownerConsent.agentMayPublishUnilaterally = true; }, /safety contract is incomplete/);
  rejects(m => { m.ownerConsent.providerCredentialsExposedToAgent = true; }, /safety contract is incomplete/);
  rejects(m => { m.ownerConsent.publicationVerification = ['canonical-production-github-commit']; }, /safety contract is incomplete/);
});

test('evidence URLs cannot carry credentials or point to unrelated domains', () => {
  rejects(m => {
    m.surfaces.browser_zip.evidence = ['https://github.com/mitchelldawkinsjr/launch-and-own/issues/45?api_token=secret'];
  }, /without secrets/);
  rejects(m => {
    m.surfaces.browser_zip.evidence = ['https://example.com/this-is-proof'];
  }, /without secrets/);
});

test('no agent surface can silently disappear', () => {
  rejects(m => { delete m.surfaces.portable_skill; }, /required distribution surface is missing/);
});

test('a reviewed portable skill may be shared as instructions without pretending to publish', () => {
  const matrix = fresh();
  matrix.surfaces.portable_skill.implementation = 'merged';
  matrix.surfaces.portable_skill.access = 'instructions_only';
  matrix.surfaces.portable_skill.verification = 'ci_only';
  assert.doesNotThrow(() => assertDistributionMatrix(matrix));
  assert.equal(matrix.surfaces.shared_mcp_api.access, 'not_available');
  rejects(m => {
    m.surfaces.browser_zip.access = 'instructions_only';
  }, /instructions-only distribution requires a reviewed, tested portable skill/);
});

test('ZIP owner-live beta status must match customer-facing guides, not old pre-rollout text', () => {
  const files = [
    '../README.md', '../docs/AGENT_DISTRIBUTION_RELEASE.md',
    '../docs/TWO_FLOW_PRODUCT_ARCHITECTURE.md',
    '../skills/launch-and-own/SKILL.md', '../skills/launch-and-own/reference.md'
  ];
  const all = files.map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  assert.equal(fresh().surfaces.browser_zip.access, 'hosted_beta');
  for (const [i, doc] of all.entries()) {
    assert.match(doc, /ZIP[\s\S]{0,400}(enabled|available|browser beta|owner-tested|owner-verified)/i, files[i]);
    assert.doesNotMatch(doc, /ZIP[^\n]{0,160}(not enabled|not yet hosted|Future \/ gated|not yet available)/i, files[i]);
  }
});

test('merged skills-only Claude plugin may ship without connected MCP tools', () => {
  const matrix = fresh();
  assert.equal(matrix.surfaces.claude_plugin.implementation, 'merged');
  assert.equal(matrix.surfaces.claude_plugin.access, 'not_available');
  matrix.surfaces.claude_plugin.access = 'instructions_only';
  assert.doesNotThrow(() => assertDistributionMatrix(matrix));
  assert.equal(matrix.surfaces.shared_mcp_api.access, 'not_available');
  rejects(m => {
    m.surfaces.chatgpt_connector = {...m.surfaces.chatgpt_connector, implementation: 'merged', verification: 'ci_only', access: 'instructions_only'};
  }, /instructions-only distribution requires a reviewed, tested portable skill/);
});
