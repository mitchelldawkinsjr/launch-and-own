import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeOwnedToolkitSite, TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';

const account = 'a'.repeat(32);
const sha = 'b'.repeat(40);
const htmlSha = 'c'.repeat(64);
const readTime = 1795385000;
const repoName = 'esp-fixture-site';
const projectName = repoName + '-site';

function fixture() {
  return {
    viewer: { githubUserId: 10, githubLogin: 'customer', cloudflareAccountId: account },
    reference: { siteId: 'site_fixture', sourceKind: 'generated', githubUserId: 10, cloudflareAccountId: account,
      repositoryId: 42, repositoryName: repoName, pagesProjectId: 'project-fixture', productionBranch: 'main' },
    repository: { id: 42, name: repoName, owner: { id: 10, login: 'Customer' }, private: true, default_branch: 'main',
      description: 'Launch & Own managed site: fixture-site [job:12345678-1234-1234-1234-123456789abc]' },
    pagesAccountId: account,
    pagesProject: { id: 'project-fixture', name: projectName, subdomain: projectName + '.pages.dev', production_branch: 'main',
      source: { type: 'github', config: { owner: 'customer', owner_id: '10', repo_name: repoName,
        repo_id: '42', preview_deployment_setting: 'none', production_deployments_enabled: true } },
      build_config: { root_dir: '/', destination_dir: 'public', build_command: '' },
      canonical_deployment: { id: 'deployment-fixture', environment: 'production', latest_stage: { name: 'deploy', status: 'success' },
        deployment_trigger: { metadata: { commit_hash: sha } } } },
    publication: { repositoryId: 42, pagesProjectId: 'project-fixture', deploymentId: 'deployment-fixture',
      approvedCommitSha: sha, approvedHtmlSha256: htmlSha, publicHtmlSha256: htmlSha, verifiedAt: readTime - 1 }
  };
}

const summarize = input => summarizeOwnedToolkitSite(input, { now: readTime });

test('the toolkit exposes a verified static site and exact publication evidence to its owner', () => {
  const result = summarize(fixture());
  assert.equal(result.repositoryUrl, `https://github.com/customer/${repoName}`);
  assert.equal(result.pagesProjectUrl, `https://dash.cloudflare.com/${account}/pages/view/${projectName}`);
  assert.deepEqual(result.deployment, { state: 'verified_deployment', productionCommitSha: sha,
    lastVerified: { deploymentId: 'deployment-fixture', commitSha: sha, publicHtmlSha256: htmlSha, verifiedAt: readTime - 1 },
    verifiedUrl: `https://${projectName}.pages.dev/` });
  assert.equal(result.capabilities.static_hosting.state, 'included_verified');
  assert.equal(result.capabilities.https.state, 'included_verified');
  assert(Object.values(result.capabilities).every(({ state }) => TOOLKIT_CAPABILITY_STATES.includes(state)));
});

test('the toolkit withholds every link when the current provider ownership or association no longer matches', () => {
  for (const change of [
    f => { f.viewer = null; },
    f => { f.viewer.githubUserId = 11; },
    f => { f.viewer.cloudflareAccountId = 'd'.repeat(32); },
    f => { f.pagesAccountId = 'e'.repeat(32); },
    f => { f.repository.owner.id = 11; },
    f => { f.repository.id = 43; },
    f => { f.repository.private = false; },
    f => { f.repository.description = 'Some other site'; },
    f => { f.pagesProject.id = 'replacement-project'; },
    f => { f.pagesProject.source.config.owner_id = '11'; },
    f => { f.pagesProject.source.config.repo_id = ['42']; },
    f => { f.pagesProject.source.config.repo_id = '0042'; },
    f => { f.pagesProject.build_config.build_command = 'run-other-source'; }
  ]) {
    const input = fixture();
    change(input);
    assert.equal(summarize(input), null);
  }
  const input = fixture();
  delete input.pagesProject.source.config.owner_id;
  assert(summarize(input), 'the current GitHub owner and the linked repo ID verify older Pages metadata');
});

test('a preview, moved production SHA or same-SHA replacement deployment cannot become the verified public link', () => {
  for (const change of [
    f => { f.pagesProject.canonical_deployment.environment = 'preview'; },
    f => { f.pagesProject.canonical_deployment.deployment_trigger.metadata.commit_hash = 'e'.repeat(40); },
    f => { f.pagesProject.canonical_deployment.id = 'new-deployment-id'; }
  ]) {
    const input = fixture();
    change(input);
    const result = summarize(input);
    assert.equal(result.deployment.verifiedUrl, null);
    assert.equal(result.deployment.lastVerified.commitSha, sha);
    assert.notEqual(result.deployment.state, 'verified_deployment');
  }
});

test('metadata alone and a mismatched public HTML hash do not prove deployment', () => {
  for (const change of [
    f => { delete f.publication; },
    f => { f.publication.publicHtmlSha256 = 'e'.repeat(64); },
    f => { f.publication.pagesProjectId = 'unrelated-project'; },
    f => { f.publication.verifiedAt = readTime + 1; }
  ]) {
    const input = fixture();
    change(input);
    const result = summarize(input);
    assert.equal(result.deployment.state, 'production_unverified');
    assert.equal(result.deployment.lastVerified, null);
    assert.equal(result.deployment.verifiedUrl, null);
  }
});

test('configured previews and an analytics tag cannot unlock URLs, metrics or settings changes', () => {
  const input = fixture();
  input.reference.sourceKind = 'uploaded-zip';
  input.pagesProject.source.config.preview_deployment_setting = 'custom';
  input.pagesProject.latest_deployment = { url: 'https://private-preview-fixture.example' };
  input.pagesProject.build_config.web_analytics_tag = 'unverified-tag';
  input.pagesProject.build_config.web_analytics_token = 'sensitive-token-fixture';
  const result = summarize(input);
  assert.deepEqual(result.capabilities.pr_previews, { state: 'blocked_permission_or_plan',
    reason: 'preview_access_and_approval_required', configuration: 'custom_branches' });
  assert.deepEqual(result.capabilities.web_analytics, { state: 'manual_setup', reason: 'review_provider_settings',
    activation: 'not_available' });
  assert.equal(result.capabilities.website_updates.reason, 'uploaded_source_has_no_supported_editor');
  assert.doesNotMatch(JSON.stringify(result), /sensitive-token-fixture|unverified-tag|private-preview-fixture/);
});

test('optional #30 editor eligibility marks website_updates available_opt_in', () => {
  const pending = summarize(fixture());
  assert.equal(pending.capabilities.website_updates.state, 'not_available');
  assert.equal(pending.capabilities.website_updates.reason, 'update_acceptance_pending');

  const eligible = summarizeOwnedToolkitSite(fixture(), {editorEligible: true});
  assert.equal(eligible.capabilities.website_updates.state, 'available_opt_in');
  assert.equal(eligible.capabilities.website_updates.reason, 'editor_eligible');

  const zip = summarizeOwnedToolkitSite({
    ...fixture(),
    reference: {...fixture().reference, sourceKind: 'uploaded-zip'}
  }, {editorEligible: true});
  assert.equal(zip.capabilities.website_updates.state, 'not_available');
  assert.equal(zip.capabilities.website_updates.reason, 'uploaded_source_has_no_supported_editor');
});
