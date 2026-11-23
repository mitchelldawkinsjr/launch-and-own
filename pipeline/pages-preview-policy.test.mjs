import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPreviewPolicy, classifyPreviewPolicy, planPreviewPolicy, previewExposureNotice,
  UPDATE_BRANCH_PATTERN
} from './pages-preview-policy.mjs';

const accountId = 'abcdef0123456789abcdef0123456789';
const expected = {projectId: 'proj-1', projectName: 'esp-demo', owner: 'Owner', repositoryId: 99};

function project(config = {}) {
  return {
    id: 'proj-1', name: 'esp-demo', subdomain: 'esp-demo.pages.dev', production_branch: 'main',
    source: {type: 'github', config: {
      owner: 'owner', repo_name: 'esp-demo', repo_id: '99', production_branch: 'main',
      production_deployments_enabled: true, preview_deployment_setting: 'none', ...config
    }}
  };
}

function fakeCloudflare(initial, {mutateOnGet} = {}) {
  let state = structuredClone(initial);
  const calls = [];
  const cloudflare = async (path, opts) => {
    calls.push({path, method: opts.method || 'GET', body: opts.body});
    if (opts.method === 'PATCH') {
      state.source.config = {...state.source.config, ...opts.body.source.config};
      return state;
    }
    if (mutateOnGet) mutateOnGet(state, calls);
    return structuredClone(state);
  };
  return {cloudflare, calls, get state() { return state; }};
}

test('classifies preview exposure without treating custom patterns as safe', () => {
  assert.equal(classifyPreviewPolicy(project()).state, 'off');
  assert.equal(classifyPreviewPolicy(project()).capability, 'available_opt_in');
  assert.equal(classifyPreviewPolicy(project({preview_deployment_setting: 'all'})).state, 'unsafe_all');
  const scoped = classifyPreviewPolicy(project({preview_deployment_setting: 'custom',
    preview_branch_includes: [UPDATE_BRANCH_PATTERN], preview_branch_excludes: ['main']}));
  assert.equal(scoped.state, 'scoped');
  assert.equal(scoped.publicPreviews, true);
  assert.equal(classifyPreviewPolicy(project({preview_deployment_setting: 'custom',
    preview_branch_includes: ['*'], preview_branch_excludes: ['main']})).state, 'unsafe_custom');
  assert.equal(classifyPreviewPolicy(project({preview_deployment_setting: 'custom',
    preview_branch_includes: [UPDATE_BRANCH_PATTERN], preview_branch_excludes: []})).state, 'unsafe_custom');
  assert.equal(classifyPreviewPolicy({source: {type: 'direct_upload'}}).state, 'unknown');
  assert.equal(classifyPreviewPolicy(null).capability, 'not_available');
});

test('plan is exact, keeps the Git link and binds identity + current state', async () => {
  const plan = await planPreviewPolicy(project(), expected, 'enable_scoped');
  assert.deepEqual(plan.patch, {source: {type: 'github', config: {
    owner: 'owner', repo_name: 'esp-demo', production_branch: 'main',
    production_deployments_enabled: true, preview_deployment_setting: 'custom',
    preview_branch_includes: [UPDATE_BRANCH_PATTERN], preview_branch_excludes: ['main']
  }}});
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(plan.noop, false);
  const other = await planPreviewPolicy(project({preview_deployment_setting: 'all'}), expected, 'enable_scoped');
  assert.notEqual(other.digest, plan.digest);
  const disable = await planPreviewPolicy(project(), expected, 'disable');
  assert.equal(disable.noop, true);
  await assert.rejects(planPreviewPolicy(project(), expected, 'enable_all'), /unknown_action/);
});

test('plan refuses projects that are not the expected owned Git project', async () => {
  for (const bad of [
    {...project(), id: 'proj-2'},
    {...project(), production_branch: 'release'},
    project({repo_id: '100'}),
    project({owner: 'someone-else'}),
    project({production_deployments_enabled: false}),
    {...project(), source: {type: 'direct_upload', config: project().source.config}}
  ]) await assert.rejects(planPreviewPolicy(bad, expected, 'enable_scoped'), /fence_mismatch/);
});

test('apply: approved digest -> PATCH -> verified scoped state', async () => {
  const cf = fakeCloudflare(project());
  const {digest} = await planPreviewPolicy(project(), expected, 'enable_scoped');
  const out = await applyPreviewPolicy({cloudflare: cf.cloudflare, accountId, expected,
    action: 'enable_scoped', approvedDigest: digest});
  assert.deepEqual(out, {action: 'enable_scoped', state: 'scoped', projectId: 'proj-1', changed: true});
  assert.deepEqual(cf.calls.map(c => c.method), ['GET', 'PATCH', 'GET']);
  assert.equal(cf.calls[1].path, `/accounts/${accountId}/pages/projects/esp-demo`);

  const {digest: off} = await planPreviewPolicy(cf.state, expected, 'disable');
  const back = await applyPreviewPolicy({cloudflare: cf.cloudflare, accountId, expected,
    action: 'disable', approvedDigest: off});
  assert.equal(back.state, 'off');
});

test('apply refuses missing, stale or mismatched approval and never PATCHes', async () => {
  const cf = fakeCloudflare(project());
  await assert.rejects(applyPreviewPolicy({cloudflare: cf.cloudflare, accountId, expected,
    action: 'enable_scoped'}), /not_approved/);
  const {digest} = await planPreviewPolicy(project(), expected, 'enable_scoped');
  const moved = fakeCloudflare(project({preview_deployment_setting: 'all'}));
  await assert.rejects(applyPreviewPolicy({cloudflare: moved.cloudflare, accountId, expected,
    action: 'enable_scoped', approvedDigest: digest}), /stale_approval/);
  await assert.rejects(applyPreviewPolicy({cloudflare: cf.cloudflare, accountId, expected,
    action: 'disable', approvedDigest: digest}), /stale_approval/);
  await assert.rejects(applyPreviewPolicy({cloudflare: cf.cloudflare, accountId: 'nope', expected,
    action: 'enable_scoped', approvedDigest: digest}), /invalid_target/);
  assert.ok(![...cf.calls, ...moved.calls].some(c => c.method === 'PATCH'));
});

test('apply fails closed when the provider does not confirm the scoped policy', async () => {
  const cf = fakeCloudflare(project());
  const real = cf.cloudflare;
  const lying = async (path, opts) => opts.method === 'PATCH' ? real(path, {...opts, body:
    {source: {config: {preview_deployment_setting: 'all'}}}}) : real(path, opts);
  const {digest} = await planPreviewPolicy(project(), expected, 'enable_scoped');
  await assert.rejects(applyPreviewPolicy({cloudflare: lying, accountId, expected,
    action: 'enable_scoped', approvedDigest: digest}), /verify_failed/);
});

test('exposure notice states public links, branch scope, quota and manual Access', () => {
  const text = previewExposureNotice('esp-demo').join(' ');
  for (const phrase of [/public/, /launch-and-own\/site-\*/, /build allowance/, /Cloudflare Access/, /off again/])
    assert.match(text, phrase);
});
