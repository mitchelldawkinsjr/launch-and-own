import test from 'node:test';
import assert from 'node:assert/strict';
import {
  websiteUrlForSlug, githubRepoUrl, updatePublicationLadder,
  projectToolkitCard, renderUpdateStatusBody, renderToolkitPage,
  historyToolkitCapabilities
} from './post-launch-toolkit.mjs';
import {
  connectTenant, harness, originalFetch, approvePreview, newPreview, post, makeDue
} from './worker-test-support.mjs';

test('toolkit URL helpers only accept managed slug shapes', () => {
  assert.equal(websiteUrlForSlug('willow-studio'),
    'https://esp-willow-studio-site.pages.dev/');
  assert.equal(websiteUrlForSlug('../evil'), null);
  assert.equal(githubRepoUrl('tester', 'willow-studio'),
    'https://github.com/tester/esp-willow-studio');
  assert.equal(githubRepoUrl('tester/../x', 'willow-studio'), null);
});

test('update publication ladder highlights merge until verified live', () => {
  const waiting = updatePublicationLadder({prStatus: 'awaiting-customer-merge'});
  assert.equal(waiting.current, 'merge');
  assert.equal(waiting.primaryAction.label, 'Open update to publish');
  assert.ok(waiting.steps.some(s => s.id === 'merge' && s.active));

  const publishing = updatePublicationLadder({
    prStatus: 'merged', verifyStatus: 'pending_deployment'
  });
  assert.equal(publishing.current, 'publishing');

  const live = updatePublicationLadder({prStatus: 'merged', verifyStatus: 'live'});
  assert.equal(live.current, 'live');
  assert.equal(live.primaryAction.label, 'View live website');

  const closed = updatePublicationLadder({prStatus: 'closed-unmerged'});
  assert.equal(closed.current, 'closed');
  assert.equal(closed.primaryAction.label, 'Start a fresh edit');
  assert.ok(!closed.steps.some(s => s.id === 'merge' && s.active));
});

test('toolkit card never invents live URL or analytics for non-live jobs', () => {
  const pending = projectToolkitCard({
    id: '11111111-1111-4111-8111-111111111111',
    customer_name: 'Willow Studio',
    site_slug: 'willow-studio',
    github_login: 'tester',
    display_status: 'pending_deployment',
    expected_commit_sha: 'a'.repeat(40),
    approval_digest: 'b'.repeat(64),
    pages_project_id: 'proj',
    expires_at: 1_800_000_000
  });
  assert.equal(pending.websiteUrl, null);
  assert.equal(pending.statusLabel, 'Publishing');
  assert.equal(pending.capabilities.web_analytics.state, 'manual_setup');
  assert.equal(pending.capabilities.pr_previews.state, 'blocked_permission_or_plan');
  assert.equal(pending.capabilities.website_updates.state, 'not_available');
  assert.equal(pending.verifiedAt, null);
  assert.equal(pending.expiresAt, 1_800_000_000);

  const live = projectToolkitCard({
    id: '11111111-1111-4111-8111-111111111111',
    customer_name: 'Willow Studio',
    site_slug: 'willow-studio',
    github_login: 'tester',
    display_status: 'live',
    expected_commit_sha: 'a'.repeat(40),
    approval_digest: 'b'.repeat(64),
    pages_project_id: 'proj',
    approved_at: 1_700_000_000,
    expires_at: 1_800_000_000
  }, {canEdit: true});
  assert.equal(live.websiteUrl, 'https://esp-willow-studio-site.pages.dev/');
  assert.equal(live.editPath, '/site-update?id=11111111-1111-4111-8111-111111111111');
  assert.equal(live.verifiedAt, 1_700_000_000);
  assert.equal(live.capabilities.website_updates.state, 'available_opt_in');
  assert.equal(live.capabilities.static_hosting.state, 'included_verified');
});

test('history capabilities mark ZIP sites without the editor', () => {
  const caps = historyToolkitCapabilities({live: true, canEdit: false, uploadedZip: true});
  assert.equal(caps.website_updates.state, 'not_available');
  assert.equal(caps.website_updates.reason, 'uploaded_source_has_no_supported_editor');
});

test('update status HTML leads with Open update to publish for open PRs', () => {
  const escape = s => String(s);
  const html = renderUpdateStatusBody({
    pr: {
      status: 'awaiting-customer-merge',
      pullRequest: 'https://github.com/tester/esp-willow-studio/pull/3'
    },
    verifyResult: null,
    approvedHtmlSha256: 'c'.repeat(64),
    ticketRaw: 'ticketvalue',
    escape
  });
  assert.match(html, /Open update to publish/);
  assert.match(html, /Publish in GitHub/);
  assert.match(html, /https:\/\/github\.com\/tester\/esp-willow-studio\/pull\/3/);
  assert.doesNotMatch(html, /reviewable pull request/i);
});

test('closed PR status HTML retires the Merge CTA', () => {
  const escape = s => String(s);
  const html = renderUpdateStatusBody({
    pr: {
      status: 'closed-unmerged',
      pullRequest: 'https://github.com/tester/esp-willow-studio/pull/9'
    },
    verifyResult: null,
    approvedHtmlSha256: 'd'.repeat(64),
    ticketRaw: 'ticketvalue',
    escape
  });
  assert.doesNotMatch(html, /Open update to publish/);
  assert.match(html, /closed without publishing/i);
});

test('GET /toolkit lists a live owned site without provider writes', async () => {
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const tenant = await connectTenant(h);
    const id = await newPreview(h, tenant);
    assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
    makeDue(h);
    assert.equal((await post(h, '/launch', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);
    makeDue(h);
    assert.equal((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);

    const writesBefore = h.calls.filter(c =>
      c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' ||
      c.method === 'DELETE'
    ).length;
    const page = await h.request('/toolkit', {cookie: tenant.cookie});
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Your website toolkit/);
    assert.match(html, /Willow Studio/);
    assert.match(html, /Live/);
    assert.match(html, /esp-willow-studio-site\.pages\.dev/);
    assert.match(html, /Update this website/);
    assert.match(html, /Visitor insights/);
    const writesAfter = h.calls.filter(c =>
      c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' ||
      c.method === 'DELETE'
    ).length;
    assert.equal(writesAfter, writesBefore, 'toolkit GET must not mutate providers');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('toolkit page without Cloudflare account stays a soft prompt', () => {
  const html = renderToolkitPage([], null, {
    view: (title, body) => title + '\n' + body,
    escape: s => String(s)
  });
  assert.match(html, /Connect GitHub/);
});
