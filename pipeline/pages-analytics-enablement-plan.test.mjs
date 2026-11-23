import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnalyticsOptInReview} from './option-feature-review.mjs';
import {readPagesAnalyticsStatus} from './pages-analytics.mjs';
import {buildPagesAnalyticsEnablementPlan} from './pages-analytics-enablement-plan.mjs';

const account = 'a'.repeat(32);
const uuid = '12345678-1234-4234-8234-123456789abc';
const projectName = 'esp-willow-site';

function site() {
  return {
    jobId: uuid, githubUserId: 42, repositoryId: 77,
    githubOwner: 'siteowner', repositoryName: 'esp-willow',
    cloudflareAccountId: account, pagesProjectId: 'pages_01',
    pagesProjectName: projectName, branch: 'main'
  };
}

function option(overrides = {}) {
  const review = buildAnalyticsOptInReview({
    githubUserId: 42, cloudflareAccountId: account,
    pagesProjectName: projectName, analyticsConsent: true
  });
  assert.equal(review.status, 'awaiting_analytics_opt_in');
  return {
    id: 'abcdefab-cdef-4def-8def-abcdefabcdef', jobId: uuid,
    githubUserId: 42, cloudflareAccountId: account, kind: 'analytics',
    status: 'stored', digest: review.approvalDigest,
    canWrite: false, canActivate: false, ...overrides
  };
}

function evidence(configuration = 'not_observed') {
  return {
    feature: 'cloudflare_web_analytics', state: 'manual_setup',
    reason: 'review_cloudflare_analytics_settings',
    configuration,
    metrics: {status: 'not_queried', visitors: null, pageviews: null,
      referrers: null, topPages: null, coreWebVitals: null},
    action: 'Review Web Analytics settings',
    projectDashboardUrl: 'https://dash.cloudflare.com/' + account +
      '/pages/view/' + projectName,
    analyticsDashboardUrl: null,
    reviewBinding: site()
  };
}

function fixture(overrides = {}) {
  return {
    storedOption: option(),
    trustedSite: site(),
    configurationEvidence: evidence(),
    privacyBeaconConsent: true,
    assertCurrentAuthorization: async () => true,
    ...overrides
  };
}

async function blocked(input, status) {
  const result = await buildPagesAnalyticsEnablementPlan(input);
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.readyForProviderWrite, false);
  assert.equal(result.publicationVerified, false);
  assert.equal(result.beaconVerified, false);
  assert.equal(result.metricsQueried, false);
  assert.equal(result.proposalSha256, null);
  assert.equal(result.binding, null);
}

test('exact stored opt-in + privacy consent yields review-only enablement plan', async () => {
  const input = fixture();
  const result = await buildPagesAnalyticsEnablementPlan(input);
  assert.equal(result.status, 'review-required');
  assert.equal(result.configuration, 'not_observed');
  assert.equal(result.proposedMethod, 'pages_metrics_enable_after_operator_grant');
  assert.equal(result.readyForProviderWrite, false);
  assert.equal(result.publicationVerified, false);
  assert.equal(result.beaconVerified, false);
  assert.equal(result.metricsQueried, false);
  assert.equal(result.requiresOwnerApproval, true);
  assert.equal(result.requiresOperatorGrant, true);
  assert.match(result.proposalSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.binding.pagesProjectName, projectName);
  assert.equal(result.binding.storedApprovalDigest, input.storedOption.digest);
  assert.equal(result.projectDashboardUrl,
    'https://dash.cloudflare.com/' + account + '/pages/view/' + projectName);
  assert(result.notices.some(n => /beacon/i.test(n)));
  assert.equal((await buildPagesAnalyticsEnablementPlan(input)).proposalSha256,
    result.proposalSha256);
  const encoded = JSON.stringify(result);
  assert(!encoded.includes('web_analytics_tag'));
  assert(!encoded.includes('web_analytics_token'));
  assert(!encoded.includes('active_verified'));
});

test('missing privacy beacon consent is refused', async () => {
  await blocked(fixture({privacyBeaconConsent: false}), 'blocked-privacy-consent');
  await blocked(fixture({privacyBeaconConsent: 'true'}), 'blocked-privacy-consent');
  await blocked(fixture({privacyBeaconConsent: undefined}), 'blocked-missing-evidence');
});

test('digest mismatch or wrong kind fails closed', async () => {
  await blocked(fixture({storedOption: option({digest: 'a'.repeat(64)})}),
    'blocked-stored-approval');
  await blocked(fixture({storedOption: option({kind: 'seo'})}),
    'blocked-stored-approval');
  await blocked(fixture({storedOption: option({canWrite: true})}),
    'blocked-stored-approval');
  await blocked(fixture({storedOption: option({status: 'approved'})}),
    'blocked-stored-approval');
});

test('already-reported tag requires manual verification, not enablement plan', async () => {
  await blocked(fixture({configurationEvidence: evidence('tag_reported_activation_unverified')}),
    'manual-review-required');
});

test('fabricated metrics or wrong dashboard link are refused', async () => {
  const badMetrics = evidence();
  badMetrics.metrics = {...badMetrics.metrics, status: 'ok', visitors: 0};
  await blocked(fixture({configurationEvidence: badMetrics}),
    'blocked-configuration-evidence');
  const badLink = evidence();
  badLink.projectDashboardUrl = 'https://dash.cloudflare.com/:account/pages/view/' + projectName;
  await blocked(fixture({configurationEvidence: badLink}),
    'blocked-configuration-evidence');
  const secrets = evidence();
  secrets.configuration = 'active_verified';
  await blocked(fixture({configurationEvidence: secrets}),
    'blocked-configuration-evidence');
});

test('site identity and authorization fences hold', async () => {
  await blocked(fixture({trustedSite: {...site(), branch: 'dev'}}),
    'blocked-site-identity');
  await blocked(fixture({trustedSite: {...site(), pagesProjectName: 'other-site'}}),
    'blocked-site-identity');
  await blocked(fixture({assertCurrentAuthorization: async () => false}),
    'blocked-authorization');
  await blocked(fixture({assertCurrentAuthorization: undefined}),
    'blocked-authorization');
});

test('input mutation during await fails closed', async () => {
  const input = fixture();
  let calls = 0;
  input.assertCurrentAuthorization = async () => {
    calls += 1;
    if (calls === 1) input.privacyBeaconConsent = false;
    return true;
  };
  await blocked(input, 'blocked-review-context-changed');
});

test('same dashboard URL cannot substitute evidence for a different Pages project or GitHub repository', async () => {
  for (const reviewBinding of [
    {...site(), pagesProjectId: 'pages_replaced'},
    {...site(), repositoryId: 78},
    undefined
  ]) {
    await blocked(fixture({configurationEvidence: {...evidence(), reviewBinding}}),
      'blocked-configuration-evidence');
  }
});

test('final authorization recheck is bound to the exact proposal and catches consent changes', async () => {
  const input = fixture();
  const calls = [];
  input.assertCurrentAuthorization = async binding => {
    calls.push(binding);
    assert(Object.isFrozen(binding));
    assert.equal(binding.pagesProjectId, input.trustedSite.pagesProjectId);
    assert.equal(binding.repositoryId, input.trustedSite.repositoryId);
    assert.equal(binding.storedOptionId, input.storedOption.id);
    assert.equal(binding.storedApprovalDigest, input.storedOption.digest);
    if (calls.length === 2) {
      await Promise.resolve();
      input.privacyBeaconConsent = false;
    }
    return true;
  };
  await blocked(input, 'blocked-review-context-changed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
});

test('replacing the authorization callback during review fails closed', async () => {
  const input = fixture();
  let replacementUsed = false;
  input.assertCurrentAuthorization = async () => {
    await Promise.resolve();
    input.assertCurrentAuthorization = async () => {
      replacementUsed = true;
      return true;
    };
    return true;
  };
  await blocked(input, 'blocked-review-context-changed');
  assert.equal(replacementUsed, false);
});

test('the status adapter can supply ID-bound evidence without changing its public projection', async () => {
  const trustedSite = site();
  const calls = [];
  const options = {
    site: trustedSite,
    principal: {githubUserId: trustedSite.githubUserId, cloudflareAccountId: account},
    cloudflareAccessToken: 'test-token',
    assertCurrentAuthorization: async () => true,
    fetchFn: async (url, request) => {
      calls.push({url, method: request.method});
      return Response.json({success: true, result: {
        id: trustedSite.pagesProjectId,
        name: projectName,
        subdomain: projectName + '.pages.dev',
        production_branch: trustedSite.branch,
        uses_functions: false,
        source: {type: 'github', config: {
          owner: trustedSite.githubOwner,
          owner_id: String(trustedSite.githubUserId),
          repo_name: trustedSite.repositoryName,
          repo_id: String(trustedSite.repositoryId),
          production_deployments_enabled: true
        }},
        build_config: {root_dir: '', destination_dir: 'public', build_command: ''}
      }});
    }
  };

  const status = await readPagesAnalyticsStatus(options);
  assert.equal(Object.hasOwn(status, 'reviewBinding'), false);
  const configurationEvidence = await readPagesAnalyticsStatus(options, {includeReviewBinding: true});
  assert(Object.isFrozen(configurationEvidence.reviewBinding));
  const result = await buildPagesAnalyticsEnablementPlan(fixture({trustedSite, configurationEvidence}));
  assert.equal(result.status, 'review-required');
  assert.equal(result.readyForProviderWrite, false);
  assert.deepEqual(calls, Array(2).fill({
    method: 'GET',
    url: 'https://api.cloudflare.com/client/v4/accounts/' + account + '/pages/projects/' + projectName
  }));
});
