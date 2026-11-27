import test from 'node:test';
import assert from 'node:assert/strict';
import {
  websiteUrlForSlug, updatePublicationLadder,
  projectToolkitCard, renderUpdateStatusBody, renderToolkitPage,
  historyToolkitCapabilities
} from './post-launch-toolkit.mjs';
import {
  accountId, approvePreview, connectTenant, harness, makeDue, newPreview, post
} from './worker-test-support.mjs';

test('the recorded site address accepts only managed slug shapes', () => {
  assert.equal(websiteUrlForSlug('willow-studio'),
    'https://esp-willow-studio-site.pages.dev/');
  assert.equal(websiteUrlForSlug('../evil'), null);
});

test('update publication ladder highlights merge until verified live', () => {
  const waiting = updatePublicationLadder({prStatus: 'awaiting-customer-merge'});
  assert.equal(waiting.current, 'merge');
  assert.equal(waiting.primaryAction.label, 'Open the change to publish');
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
  assert.equal(closed.primaryAction, null);
});

test('the toolkit displays exact launch evidence only for complete successful records', () => {
  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    customer_name: 'Willow Studio',
    site_slug: 'willow-studio',
    display_status: 'pending_deployment',
    expected_commit_sha: 'a'.repeat(40),
    approval_digest: 'b'.repeat(64),
    updated_at: 1795345200,
    approved_at: 1795345100,
    expires_at: 1795345100 + 30 * 24 * 60 * 60
  };
  const pending = projectToolkitCard(record, {canEdit: true});
  assert.equal(pending.recordedWebsite, null);
  assert.equal(pending.statusLabel, 'Publishing');
  assert.equal(pending.verifiedAt, null);
  assert.equal(pending.editPath, null);
  assert.equal(pending.capabilities.web_analytics.state, 'manual_setup');
  assert.equal(pending.capabilities.website_updates.state, 'not_available');
  assert.equal(pending.capabilities.pr_previews.state, 'blocked_permission_or_plan');

  const live = projectToolkitCard({...record, display_status: 'live'}, {canEdit: true});
  assert.equal(live.recordedWebsite, 'https://esp-willow-studio-site.pages.dev/');
  assert.equal(live.editPath, '/site-update?id=11111111-1111-4111-8111-111111111111');
  assert.equal(live.optionsPath, '/site-options?id=11111111-1111-4111-8111-111111111111');
  assert.equal(live.verifiedAt, new Date(record.updated_at * 1000).toISOString());
  assert.equal(live.expiresAt, new Date(record.expires_at * 1000).toISOString());
  assert.equal(live.verifiedCommitSha, record.expected_commit_sha);
  assert.equal(live.approvalFingerprint, record.approval_digest);
  assert.equal(live.capabilities.website_updates.state, 'available_opt_in');
  assert.equal(live.capabilities.static_hosting.state, 'included_verified');
  assert.equal(projectToolkitCard({...record, display_status: 'live', updated_at: null},
    {canEdit: true}).editPath, null);
  assert.equal(projectToolkitCard(record, {canEdit: true}).optionsPath, null);
});

test('history capabilities offer imported editing only after a live ZIP launch', () => {
  const caps = historyToolkitCapabilities({
    verified: true, canEdit: false, uploadedZip: true
  });
  assert.equal(caps.website_updates.state, 'available_opt_in');
  assert.equal(caps.website_updates.reason, 'imported_edit_ready');
  const waiting = historyToolkitCapabilities({
    verified: false, canEdit: false, uploadedZip: true
  });
  assert.equal(waiting.website_updates.state, 'not_available');
  assert.equal(waiting.website_updates.reason, 'uploaded_source_has_no_supported_editor');
});

test('update status HTML leads with Open the change to publish for open PRs', () => {
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
  assert.match(html, /Open the change to publish/);
  assert.match(html, /Merged in GitHub/);
  assert.match(html, /https:\/\/github\.com\/tester\/esp-willow-studio\/pull\/3/);
  assert.doesNotMatch(html, /reviewable pull request/i);
});

test('GET /toolkit fences retained history, uses a bounded display query and makes no provider writes', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  t.mock.method(globalThis, 'fetch', h.fetchFn);
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
  const statements = [];
  const prepare = h.DB.prepare;
  let revokeDuringHistoryRead = false;
  t.mock.method(h.DB, 'prepare', sql => {
    statements.push(sql);
    if (revokeDuringHistoryRead && /FROM onboarding_launch_jobs j/.test(sql))
      h.sqlite.prepare('UPDATE onboarding_sessions SET authorization_epoch = authorization_epoch + 1').run();
    return prepare(sql);
  });
  const toolkit = () => h.request('/toolkit', {cookie: tenant.cookie});
  const page = await toolkit();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /no-store/);
  const html = await page.text();
  assert.match(html, /Your website toolkit/);
  assert.match(html, /Willow Studio/);
  assert.match(html, /Last checked <time/);
  assert.match(html, /Stays on this list until <time/);
  assert.match(html, /Approval fingerprint/);
  assert.match(html, /Recent launches/);
  assert.match(html, /30 days/);
  assert.match(html, /Choose what you want to do/);
  assert.match(html, /Public address when checked: <code>https:\/\/esp-willow-studio-site\.pages\.dev\//);
  assert.doesNotMatch(html, /href="https:\/\/esp-willow-studio-site\.pages\.dev/);
  assert.match(html, /Recent launches/);
  assert.match(html, /Choose what you want to do/);
  assert.doesNotMatch(html, /Sites we found in your accounts|Other sites in your accounts/);
  const card = html.slice(html.indexOf('<section class="tk-site">'), html.indexOf('</section>', html.indexOf('<section class="tk-site">')));
  assert.match(card, /In your accounts now/);
  assert.match(card, /class="tk-action" href="\/toolkit\/source\?ticket=[^"]+"><strong>Check it is live/, 'a site found in the accounts offers a live check');
  assert.match(card, /href="https:\/\/github\.com\/tester\/esp-willow-studio"/);
  assert.match(html, /Edit your website/);
  assert.match(html, /Visitor insights/);
  const writesAfter = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' ||
    c.method === 'DELETE'
  ).length;
  assert.equal(writesAfter, writesBefore, 'toolkit GET must not mutate providers');
  const historyReads = statements.filter(sql => /FROM onboarding_launch_jobs j/.test(sql));
  assert.equal(historyReads.length, 1);
  assert.doesNotMatch(historyReads[0], /SELECT j\.\*|approved_html/);

  h.sqlite.prepare("UPDATE onboarding_launch_jobs SET plan_json = json_set(plan_json, '$.zip', json('{}'))").run();
  const zip = await (await toolkit()).text();
  assert.doesNotMatch(zip, /Update this website/);
  assert.match(zip, /Edit your website/);
  assert.match(zip, /Open the visual editor, preview the exact page/i);
  assert.match(zip, /Safe website updates/);

  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_account_id = ?').run('a'.repeat(32));
  assert.doesNotMatch(await (await toolkit()).text(), /Willow Studio/);
  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_account_id = ?').run(accountId);
  h.resourceState.githubRevoked = true;
  let response = await toolkit();
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /Willow Studio/);
  h.resourceState.githubRevoked = false;

  revokeDuringHistoryRead = true;
  response = await toolkit();
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /Willow Studio/);
  revokeDuringHistoryRead = false;
  h.sqlite.prepare('UPDATE onboarding_launch_jobs SET expires_at = 0').run();
  response = await toolkit();
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /Willow Studio/);
});

test('toolkit page without Cloudflare account stays a soft prompt', () => {
  const html = renderToolkitPage([], null, {
    view: (title, body) => title + '\n' + body,
    escape: s => String(s)
  });
  assert.match(html, /Connect GitHub/);
});

test('toolkit groups each site into Overview, Updates, Services and Settings without losing evidence or actions', () => {
  const card = {name: 'Willow <b>', statusLabel: 'Live and checked', statusDetail: 'Recorded live.',
    recordedWebsite: 'https://willow.pages.dev/', verifiedAt: '2026-11-25T10:00:00.000Z', verifiedCommitSha: 'a'.repeat(40),
    approvalFingerprint: 'b'.repeat(64), editPath: '/site-update?id=x', optionsPath: '/options?id=x',
    capabilities: {website_updates: {state: 'available_opt_in', detail: 'Change the copy safely.'},
      static_hosting: {state: 'included_verified', detail: 'Recorded hosting'}}};
  const html = renderToolkitPage([card, {...card, name: 'Second'}], {cloudflare_account_id: 'test'},
    {view: (_t, body) => body, escape: s => String(s).replace(/</g, '&lt;')});
  const panel = id => html.match(new RegExp('<div class="tk-panel tk-p-' + id + '">([\\s\\S]*?)</div>(?=<div class="tk-panel|</section>)'))[1];
  assert.deepEqual([...html.matchAll(/class="tk-tab"><input[^>]*aria-label="(\w+)"[^>]*><span aria-hidden="true">\1</g)].slice(0, 4).map(m => m[1]),
    ['Overview', 'Updates', 'Services', 'Settings']);
  assert.equal((html.match(/name="tk-site-0"/g) || []).length, 4);
  assert.equal((html.match(/name="tk-site-1"/g) || []).length, 4, 'each site has its own tab group');
  assert.equal((html.match(/ checked>/g) || []).length, 2, 'Overview selected per site');
  assert.match(html, /<legend class="lo-sr">Sections for Willow &lt;b><\/legend>/);
  assert.match(panel('overview'), /Public address when checked[\s\S]*Last checked <time/);
  assert.match(panel('updates'), /href="\/site-update\?id=x">Edit your website[\s\S]*Change the copy safely/);
  assert.match(panel('services'), /Add features to this website[\s\S]*Explore your website services/);
  // Actions first: one primary action per site, then the other things the owner can do.
  const actions = html.slice(html.indexOf('<ul class="tk-actions">'), html.indexOf('</ul>', html.indexOf('<ul class="tk-actions">')));
  assert.deepEqual([...actions.matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1]), ['Edit your website', 'Add features', 'Launch history']);
  assert.equal((actions.match(/is-primary/g) || []).length, 1);
  assert.ok(html.indexOf('tk-actions') < html.indexOf('tk-tabs'), 'actions come before the detail tabs');
  const pending = renderToolkitPage([{...card, editPath: null, recordedWebsite: null, continuePath: '/review?id=x', statusDetail: 'Getting ready.'}], {cloudflare_account_id: 'test'},
    {view: (_t, body) => body, escape: s => String(s)});
  assert.match(pending, /class="tk-action is-primary" href="\/review\?id=x"><strong>Continue your launch/);
  assert.match(panel('settings'), /Approval fingerprint <code>bbbbbbbbbbbb…[\s\S]*What this site includes/);
  assert.doesNotMatch(html, /<script|\bon[a-z]+=/i);
});
