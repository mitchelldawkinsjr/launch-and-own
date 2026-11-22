import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTrustedPrincipal, assertOwnedRecord, assertLinkChallenge,
  assertPreparedDraft, assertSafeBrowserHandoff, humanApprovalHandoff,
  publicationStatus, validateToolCall, OPERATIONS,
  CONTRACT_VERSION, BRIDGE_AUDIENCE, BridgeContractError
} from './tool-contract.mjs';

const account = 'abcdef0123456789abcdef0123456789';
const otherAccount = 'abcdef0123456789abcdef012345678a';
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const digest = 'c'.repeat(64);
const otherDigest = 'd'.repeat(64);
const clock = {nowSeconds: 120};
const principal = (overrides = {}) => ({
  authenticated: true, audience: BRIDGE_AUDIENCE, subject: 'owner_user_1234',
  expiresAt: 1000,
  linkedOwner: {
    githubUserId: 123, cloudflareAccountId: account,
    authorizationEpoch: 3, reauthorized: true
  },
  ...overrides
});
const ownerRecord = overrides => ({
  id: 'record_1234', subject: 'owner_user_1234',
  githubUserId: 123, cloudflareAccountId: account,
  authorizationEpoch: 3, ...overrides
});
const getScope = () => assertTrustedPrincipal(principal(), clock);
const call = (name, args = {}, who = principal()) =>
  validateToolCall({name, arguments: args}, who, clock);
const fails = (code, fn) => assert.throws(fn, error =>
  error instanceof BridgeContractError && error.code === code);

test('contract names and version remain stable across clients', () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.deepEqual(Object.keys(OPERATIONS), [
    'get_connection_status', 'start_connect_accounts', 'list_sites', 'get_site',
    'prepare_site', 'prepare_site_update', 'get_exact_preview',
    'request_explicit_approval', 'get_job_status', 'verify_publication'
  ]);
  assert.equal(Object.keys(OPERATIONS).length, 10);
  for (const op of Object.values(OPERATIONS)) {
    assert.ok(op.args.every(a => typeof a === 'string'));
    assert.ok(op.required.every(a => op.args.includes(a)));
  }
});

test('unlinked model identity may only request browser connection status/handoff', () => {
  const who = principal({linkedOwner: null});
  assert.equal(call('get_connection_status', {}, who).scope.owner, undefined);
  assert.equal(call('start_connect_accounts', {}, who).scope.owner, undefined);
  for (const name of Object.keys(OPERATIONS).filter(x =>
    !['get_connection_status', 'start_connect_accounts'].includes(x))) {
    fails('needs_reauthorization', () => call(name, {}, who));
  }
});

test('resource authentication, expiry and audience are enforced, not caller IDs', () => {
  const invalid = [
    null, {}, principal({authenticated: false}),
    principal({audience: 'github-token'}),
    principal({subject: 'a'}),
    principal({expiresAt: 119}),
    principal({linkedOwner: {...principal().linkedOwner, reauthorized: false}}),
    principal({linkedOwner: {...principal().linkedOwner, cloudflareAccountId: 'bad'}})
  ];
  for (const who of invalid) {
    const expected = who?.linkedOwner?.reauthorized === false ||
      who?.linkedOwner?.cloudflareAccountId === 'bad' ?
      'needs_reauthorization' : 'unauthenticated';
    fails(expected, () => call('get_connection_status', {}, who));
  }
  fails('unknown_tool', () => call('invent_launch_site'));
  fails('invalid_arguments', () => call('list_sites', {owner_id: 'someone_else'}));
  fails('invalid_arguments', () => call('get_site', {site_id: 'valid_site_1', githubUserId: 123}));
  const scope = call('list_sites').scope;
  assert.deepEqual(scope, {
    subject: 'owner_user_1234',
    owner: {githubUserId: 123, cloudflareAccountId: account, authorizationEpoch: 3}
  });
  assert.equal(scope.owner.access_token, undefined);
});

test('model-provided content is bounded, normalized and cannot carry provider identities', () => {
  const spec = {
    name: 'Willow Studio', headline: 'Beautiful hand-crafted design',
    about: 'Locally owned.', services: ['Design', 'Consulting'], theme: 'forest'
  };
  const prepared = call('prepare_site', {site_spec: spec});
  assert.deepEqual(prepared.arguments.site_spec, spec);
  assert.notEqual(prepared.arguments.site_spec, spec);
  fails('invalid_arguments', () => call('prepare_site', {
    site_spec: {...spec, providerToken: 'secret'}
  }));
  fails('invalid_arguments', () => call('prepare_site', {
    site_spec: {...spec, about: 'x'.repeat(13000)}
  }));
  fails('invalid_arguments', () => call('prepare_site', {
    site_spec: {...spec, services: Array(7).fill('bad')}
  }));
  fails('invalid_arguments', () => call('prepare_site_update', {
    site_id: 'site_1234', base_commit_sha: sha,
    changes: {unsafeHtml: '<script>bad()</script>'}
  }));
  assert.equal(call('prepare_site_update', {
    site_id: 'site_1234', base_commit_sha: sha,
    changes: {headline: 'Updated headline'}
  }).name, 'prepare_site_update');
  fails('invalid_arguments', () => call('prepare_site_update', {
    site_id: 'site_1234', base_commit_sha: 'truncated',
    changes: {headline: 'New'}
  }));
});

test('all site/job/draft records must match subject, both providers and epoch', () => {
  const scope = getScope();
  assert.equal(assertOwnedRecord(ownerRecord(), scope).subject, scope.subject);
  for (const altered of [
    {subject: 'other_user'},
    {githubUserId: 999},
    {cloudflareAccountId: otherAccount},
    {authorizationEpoch: 2}
  ]) {
    fails('not_found', () => assertOwnedRecord(ownerRecord(altered), scope));
  }
  fails('not_found', () => assertOwnedRecord(null, scope));
});

test('linking challenge rejects mismatched owner, expired or consumed challenges', () => {
  const challenge = {
    id: 'link_123456789', subject: 'owner_user_1234',
    expectedGithubUserId: 123, expectedCloudflareAccountId: account,
    expiresAt: 500, consumedAt: null
  };
  const verified = {githubUserId: 123, cloudflareAccountId: account};
  assert.equal(assertLinkChallenge(challenge, verified, principal(), clock).githubUserId, 123);
  for (const change of [
    {subject: 'other_user'}, {expiresAt: 119}, {consumedAt: 118},
    {expectedGithubUserId: 222}, {expectedCloudflareAccountId: otherAccount}
  ]) fails('invalid_link_challenge', () =>
    assertLinkChallenge({...challenge, ...change}, verified, principal(), clock));
  fails('invalid_link_challenge', () => assertLinkChallenge(challenge, {
    ...verified, githubUserId: 999
  }, principal(), clock));
});

test('exact-approval draft rejects expired, swapped digest, changed repo and stale base', () => {
  const scope = getScope();
  const draft = ownerRecord({
    id: 'draft_1234', state: 'prepared', kind: 'update',
    previewSha256: digest, expiresAt: 450,
    baseCommitSha: sha, repositoryId: 456
  });
  const options = {
    previewSha256: digest, nowSeconds: 120, currentCommitSha: sha, currentRepositoryId: 456
  };
  assert.equal(assertPreparedDraft(draft, scope, options).operation, 'update');
  fails('stale_preview', () => assertPreparedDraft({...draft, expiresAt: 99}, scope, options));
  fails('stale_preview', () => assertPreparedDraft(draft, scope,
    {...options, previewSha256: otherDigest}));
  fails('stale_source', () => assertPreparedDraft(draft, scope,
    {...options, currentCommitSha: nextSha}));
  fails('stale_source', () => assertPreparedDraft(draft, scope,
    {...options, currentRepositoryId: 999}));
  fails('not_found', () => assertPreparedDraft({...draft, subject: 'other_user'},
    scope, options));
  assert.equal(assertPreparedDraft({...draft, kind: 'create'}, scope,
    options).operation, 'create');
});

test('handoff only uses known non-sensitive browser URLs, never approval tokens', () => {
  for (const url of ['https://onboard.360web.cloud/', 'https://onboard.360web.cloud/review']) {
    assert.equal(assertSafeBrowserHandoff(url), url);
  }
  for (const url of [
    'https://onboard.360web.cloud.evil.example/review',
    'http://onboard.360web.cloud/review',
    'https://user:pass@onboard.360web.cloud/review',
    'https://onboard.360web.cloud/review?state=token',
    'https://onboard.360web.cloud/review#grant',
    'https://onboard.360web.cloud/approve',
    'javascript:alert(1)'
  ]) fails('unsafe_handoff', () => assertSafeBrowserHandoff(url));

  const handoff = humanApprovalHandoff({
    url: 'https://onboard.360web.cloud/review', draftId: 'draft_1234',
    previewSha256: digest, expiresAt: 400,
    token: 'must-never-appear'
  }, getScope(), clock);
  assert.deepEqual(handoff, {
    state: 'needs_human_approval', draft_id: 'draft_1234',
    preview_sha256: digest, action: 'open_hosted_review',
    action_url: 'https://onboard.360web.cloud/review'
  });
  fails('invalid_approval_handoff', () => humanApprovalHandoff({
    url: 'https://onboard.360web.cloud/review', draftId: 'draft_1234',
    previewSha256: digest, expiresAt: 5000
  }, getScope(), clock));
  fails('invalid_arguments', () => call('request_explicit_approval', {
    draft_id: 'draft_1234', preview_sha256: digest,
    idempotency_key: 'idem_12345678901234', approved: true
  }));
});

test('pending is truthful; live requires canonical commit and HTML proof', () => {
  const scope = getScope();
  const complete = ownerRecord({
    id: 'job_12345', status: 'live',
    canonicalProductionVerified: true, publicHtmlVerified: true,
    productionCommitSha: sha, verifiedCommitSha: sha,
    publicHtmlSha256: digest, approvedHtmlSha256: digest,
    githubToken: 'secret', approvedHtml: '<p>private</p>'
  });
  assert.deepEqual(publicationStatus(complete, scope), {
    job_id: 'job_12345', state: 'live',
    production_commit_sha: sha, public_html_sha256: digest
  });
  for (const change of [
    {canonicalProductionVerified: false},
    {publicHtmlVerified: false},
    {productionCommitSha: nextSha},
    {publicHtmlSha256: otherDigest},
    {verifiedCommitSha: 77}
  ]) assert.deepEqual(publicationStatus({...complete, ...change}, scope), {
    job_id: 'job_12345', state: 'pending_deployment'
  });
  assert.deepEqual(publicationStatus({...complete, status: 'queued'}, scope), {
    job_id: 'job_12345', state: 'queued'
  });
  fails('not_found', () => publicationStatus({...complete, cloudflareAccountId: otherAccount},
    scope));
});
