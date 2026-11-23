import test from 'node:test';
import assert from 'node:assert/strict';
import {
  websiteUrlForSlug, githubRepoUrl, updatePublicationLadder,
  projectToolkitCard, renderUpdateStatusBody, renderToolkitPage
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
    pages_project_id: 'proj'
  });
  assert.equal(pending.websiteUrl, null);
  assert.equal(pending.statusLabel, 'Publishing');
  assert.equal(pending.capabilities.analytics.state, 'manual_setup');
  assert.equal(pending.capabilities.prPreviews.state, 'not_available');

  const live = projectToolkitCard({
    id: '11111111-1111-4111-8111-111111111111',
    customer_name: 'Willow Studio',
    site_slug: 'willow-studio',
    github_login: 'tester',
    display_status: 'live',
    expected_commit_sha: 'a'.repeat(40),
    approval_digest: 'b'.repeat(64),
    pages_project_id: 'proj'
  }, {canEdit: true});
  assert.equal(live.websiteUrl, 'https://esp-willow-studio-site.pages.dev/');
  assert.equal(live.editPath, '/site-update?id=11111111-1111-4111-8111-111111111111');
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
