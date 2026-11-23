import assert from 'node:assert/strict';
import test from 'node:test';
import { approvePreview, connectTenant, harness, jobRow, newPreview } from '../onboarding/worker-test-support.mjs';

test('an approved browser launch enables automatic production builds with Pages previews off', async (t) => {
  const onboarding = harness();
  const projectRequests = [];
  t.after(() => onboarding.sqlite.close());
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method === 'POST' && url.endsWith('/pages/projects')) {
      projectRequests.push(JSON.parse(options.body));
    }
    return onboarding.fetchFn(url, options);
  });

  const tenant = await connectTenant(onboarding);
  const id = await newPreview(onboarding, tenant);
  assert.equal(projectRequests.length, 0);
  const approval = await approvePreview(onboarding, tenant.cookie, tenant.csrf, id);

  assert.equal(approval.status, 303);
  assert.equal(jobRow(onboarding).status, 'pending_deployment');
  assert.equal(projectRequests.length, 1);
  const [project] = projectRequests;
  assert.equal(project.production_branch, 'main');
  assert.equal(project.source.type, 'github');
  assert.equal(project.source.config.production_deployments_enabled, true);
  assert.equal(project.source.config.preview_deployment_setting, 'none');
});
