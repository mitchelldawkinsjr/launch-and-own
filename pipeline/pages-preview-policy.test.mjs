import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyPreviewPolicy, planPreviewPolicy, previewExposureNotice, UPDATE_BRANCH_PATTERN} from './pages-preview-policy.mjs';

const account = 'a'.repeat(32);
const site = {cloudflareAccountId: account, projectId: 'project-123', githubOwner: 'customer',
  githubUserId: 7, repositoryName: 'esp-test-site', repositoryId: 42, branch: 'main'};
const options = {site, pagesAccountId: account, action: 'enable_scoped'};
const scoped = {preview_deployment_setting: 'custom', preview_branch_includes: [UPDATE_BRANCH_PATTERN],
  preview_branch_excludes: ['main'], pr_comments_enabled: false};
const fixture = config => ({
  id: site.projectId, name: 'esp-test-site-site', subdomain: 'esp-test-site-site.pages.dev', production_branch: 'main',
  source: {type: 'github', config: {owner: 'customer', owner_id: '7', repo_name: 'esp-test-site',
    repo_id: '42', production_deployments_enabled: true, ...config}},
  build_config: {build_command: '', root_dir: '/', destination_dir: 'public'}
});

test('preview build configuration never establishes actual exposure or Access protection', () => {
  const cases = [
    [{preview_deployment_setting: 'none'}, 'off'],
    [{preview_deployment_setting: 'all'}, 'unsafe_all'],
    [scoped, 'scoped'],
    [{...scoped, pr_comments_enabled: true}, 'unsafe_custom'],
    [{...scoped, pr_comments_enabled: undefined}, 'unsafe_custom'],
    [{...scoped, preview_branch_includes: [UPDATE_BRANCH_PATTERN, '*']}, 'unsafe_custom'],
    [{...scoped, preview_branch_includes: [[UPDATE_BRANCH_PATTERN]]}, 'unsafe_custom'],
    [{...scoped, preview_branch_excludes: []}, 'unsafe_custom'],
    [{}, 'unknown']
  ];
  for (const [config, state] of cases) {
    const result = classifyPreviewPolicy(fixture(config));
    assert.equal(result.state, state);
    assert.equal(result.protection, 'unverified');
    assert.equal(result.capability, state === 'unknown' ? 'not_available' : 'blocked_permission_or_plan');
  }
  assert.equal(classifyPreviewPolicy({}).state, 'unknown');
});

test('the scoped plan describes proposed settings for owner review', () => {
  const project = fixture({preview_deployment_setting: 'none', preview_branch_includes: ['*']});
  const before = structuredClone(project);
  const plan = planPreviewPolicy(project, options);
  assert.deepEqual(project, before);
  assert.equal(plan.state, 'review_only');
  assert.equal(plan.before.state, 'off');
  assert.equal(plan.protection, 'unverified');
  assert.deepEqual(plan.proposed, {
    setting: 'custom', includes: [UPDATE_BRANCH_PATTERN], excludes: ['main'], prCommentsEnabled: false
  });
  assert.equal(plan.cloudflareAccountId, account);
  assert.equal('patch' in plan, false);
  assert.equal('approvedDigest' in plan, false);
});

test('the disable plan stops future builds and describes retained deployment behavior separately', () => {
  const plan = planPreviewPolicy(fixture(scoped), {...options, action: 'disable'});
  assert.deepEqual(plan.proposed, {setting: 'none', includes: [], excludes: [], prCommentsEnabled: false});
  assert.match(previewExposureNotice().join(' '), /leaves existing preview deployments in place/);
});

test('plans require the selected account and original repository, owner, project and static build', () => {
  assert.throws(() => planPreviewPolicy(fixture(scoped), {...options, pagesAccountId: 'b'.repeat(32)}),
    /verified managed site/);
  assert.throws(() => planPreviewPolicy(fixture(scoped), {...options, site: undefined}), /verified managed site/);
  for (const config of [{repo_id: ['42']}, {owner_id: '8'}, {production_deployments_enabled: false}]) {
    assert.throws(() => planPreviewPolicy(fixture(config), options), /verified managed site/);
  }
  assert.throws(() => planPreviewPolicy({...fixture(scoped), id: 'replacement'}, options), /verified managed site/);
  assert.throws(() => planPreviewPolicy({...fixture(scoped), uses_functions: true}, options), /verified managed site/);
  assert.throws(() => planPreviewPolicy(fixture(scoped), {...options, action: 'enable_all'}), /Unknown/);
});
