import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId, approvePreview, connectTenant, csrfFrom, harness, jobRow, makeDue,
  newPreview, post
} from './worker-test-support.mjs';
import { optionApprovalsReady, optionsPathForJob } from './post-launch-options.mjs';
import { validateStoredOptionApproval } from '../pipeline/stored-option-approval.mjs';

async function liveSite(h, t) {
  t.mock.method(globalThis, 'fetch', h.fetchFn);
  const tenant = await connectTenant(h);
  const id = await newPreview(h, tenant);
  assert.equal((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/launch', tenant.cookie, { csrf: tenant.csrf, id })).status, 303);
  makeDue(h);
  assert.equal((await post(h, '/verify', tenant.cookie, { csrf: tenant.csrf, id })).status, 303);
  tenant.csrf = csrfFrom(await (await h.request('/', { cookie: tenant.cookie })).text());
  return { tenant, id };
}

async function prepareDomain(h, tenant, id, hostname = 'www.example.com') {
  const response = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const digest = html.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  return { html, digest };
}

test('options path is only for live launch ids', () => {
  assert.equal(optionsPathForJob('11111111-1111-4111-8111-111111111111', 'live'),
    '/site-options?id=11111111-1111-4111-8111-111111111111');
  assert.equal(optionsPathForJob('11111111-1111-4111-8111-111111111111', 'queued'), null);
  assert.equal(optionsPathForJob('bad', 'live'), null);
});

test('toolkit links the options page and approvals store without provider writes', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);
  assert.equal(await optionApprovalsReady(h.DB), true);

  const toolkit = await (await h.request('/toolkit', { cookie: tenant.cookie })).text();
  assert.match(toolkit, new RegExp('/site-options\\?id=' + id));

  const writesBefore = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE'
  ).length;

  const { digest } = await prepareDomain(h, tenant, id);
  const saved = await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest
  });
  assert.equal(saved.status, 303);

  const row = h.sqlite.prepare(
    'SELECT kind, status, approval_digest FROM onboarding_option_approvals WHERE job_id = ?'
  ).get(id);
  assert.equal(row.kind, 'domain');
  assert.equal(row.status, 'stored');
  assert.equal(row.approval_digest, digest);

  const writesAfter = h.calls.filter(c =>
    c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE'
  ).length;
  assert.equal(writesAfter, writesBefore);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /Stored domain request/);
  assert.match(page, /www\.example\.com/);
  assert.match(page, /Existing mailbox/);
});

test('a session revoked at the storage boundary cannot save an options request', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, id} = await liveSite(h, t);
  const {digest} = await prepareDomain(h, tenant, id);
  const prepare = h.DB.prepare;
  t.mock.method(h.DB, 'prepare', sql => {
    if (sql.includes('INSERT INTO onboarding_option_approvals'))
      h.sqlite.prepare('UPDATE onboarding_sessions SET authorization_epoch = authorization_epoch + 1').run();
    return prepare(sql);
  });

  const result = await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest
  });
  assert.equal(result.status, 409);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_option_approvals').get().n, 0);
});

test('a bad digest does not store an options approval', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);
  await prepareDomain(h, tenant, id);
  const response = await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest: 'a'.repeat(64)
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /changed/i);
  assert.equal(h.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM onboarding_option_approvals WHERE job_id = ?'
  ).get(id).n, 0);
});

test('another tenant cannot open or approve options for a live site', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  h.resourceState.githubUserId = 99;
  const other = await connectTenant(h);
  const denied = await h.request('/site-options?id=' + id, { cookie: other.cookie });
  assert.equal(denied.status, 404);

  const prepare = await post(h, '/site-options-prepare', other.cookie, {
    csrf: other.csrf, id, kind: 'domain', hostname: 'www.example.com'
  });
  assert.equal(prepare.status, 404);
  assert.equal(h.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM onboarding_option_approvals'
  ).get().n, 0);
  assert.equal(accountId.length, 32);
});

test('email stays closed until a domain approval is stored', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /Save a custom domain request first/);
  assert.doesNotMatch(page, /name="mailbox"/);

  const early = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com'
  });
  assert.equal(early.status, 400);
  assert.match(await early.text(), /custom domain/i);

  const { digest } = await prepareDomain(h, tenant, id);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest
  })).status, 303);

  // The onboarding contact email pre-fills forwarding, unless it is on the site hostname.
  const setContact = email => {
    const plan = JSON.parse(jobRow(h).plan_json);
    plan.site = { ...plan.site, contactEmail: email };
    h.sqlite.prepare('UPDATE onboarding_launch_jobs SET plan_json = ? WHERE id = ?')
      .run(JSON.stringify(plan), id);
  };
  const mailboxValue = async () => (await (await h.request('/site-options?id=' + id,
    { cookie: tenant.cookie })).text()).match(/name="mailbox"[^>]*value="([^"]*)"/)?.[1];
  setContact('owner@elsewhere.com');
  assert.equal(await mailboxValue(), 'owner@elsewhere.com');
  setContact('hello@www.example.com');
  assert.equal(await mailboxValue(), '');
  setContact('a'.repeat(81) + '@elsewhere.com');
  assert.equal(await mailboxValue(), '');
  setContact('');
  assert.equal(await mailboxValue(), '');

  const emailPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com'
  });
  assert.equal(emailPrep.status, 200);
  const emailHtml = await emailPrep.text();
  const emailDigest = emailHtml.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(emailDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'you@elsewhere.com', digest: emailDigest
  })).status, 303);
  const emailRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'email');
  const payload = JSON.parse(emailRow.payload_json);
  assert.equal(payload.plan.kind, 'launch-and-own-email-routing-approval');
  assert.equal(payload.plan.mailbox, 'you@elsewhere.com');
  assert.equal(payload.plan.alias, 'contact@www.example.com');
  assert.equal(emailRow.approval_digest, emailDigest);
  const job = jobRow(h);
  const validated = validateStoredOptionApproval(emailRow, {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  });
  assert.equal(validated.kind, 'email');
  assert.equal(validated.normalizedPayload.mailbox, 'you@elsewhere.com');
  assert.equal(validated.canWrite, false);
  assert.equal(h.sqlite.prepare(
    'SELECT kind FROM onboarding_option_approvals WHERE job_id = ? ORDER BY kind'
  ).all(id).map(row => row.kind).join(','), 'domain,email');

  const sameHost = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'email', hostname: 'www.example.com',
    mailbox: 'owner@www.example.com'
  });
  assert.equal(sameHost.status, 400);

  setContact('owner@elsewhere.com');
  const prepare = h.DB.prepare.bind(h.DB);
  t.mock.method(h.DB, 'prepare', sql => {
    const statement = prepare(sql);
    if (sql.includes('FROM onboarding_option_approvals WHERE job_id = ? ORDER BY kind')) {
      h.sqlite.prepare('UPDATE onboarding_sessions SET authorization_epoch = authorization_epoch + 1').run();
    }
    return statement;
  });
  const changed = await h.request('/site-options?id=' + id, { cookie: tenant.cookie });
  assert.equal(changed.status, 403);
  assert.doesNotMatch(await changed.text(), /owner@elsewhere\.com/);
});

test('forms without consent cannot be stored', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const denied = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com'
  });
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /consent/i);

  const prepared = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com', formsConsent: 'true'
  });
  assert.equal(prepared.status, 200);
  const html = await prepared.text();
  assert.match(html, /does not create a working form|No widget/i);
  const digest = html.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'forms', ownerEmail: 'owner@example.com',
    formsConsent: 'true', digest
  })).status, 303);

  const payload = JSON.parse(h.sqlite.prepare(
    'SELECT payload_json FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'forms').payload_json);
  assert.equal(payload.workingForm, false);
  assert.equal(payload.createResources, false);
  assert.equal(payload.canActivate, false);
});

test('analytics and preview opt-ins store without enabling provider settings', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /Visitor insights/);
  assert.match(page, /Private update previews/);

  assert.equal((await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'analytics'
  })).status, 400);

  const analyticsPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'analytics', analyticsConsent: 'true'
  });
  assert.equal(analyticsPrep.status, 200);
  const analyticsDigest = (await analyticsPrep.text())
    .match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(analyticsDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'analytics', analyticsConsent: 'true', digest: analyticsDigest
  })).status, 303);

  assert.equal((await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'pr_previews', previewConsent: 'true'
  })).status, 400);

  const previewPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'pr_previews',
    previewConsent: 'true', acknowledgePublicPreviews: 'true'
  });
  assert.equal(previewPrep.status, 200);
  const previewHtml = await previewPrep.text();
  assert.match(previewHtml, /Access is reviewed|preview builds stay off/i);
  const previewDigest = previewHtml.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(previewDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'pr_previews',
    previewConsent: 'true', acknowledgePublicPreviews: 'true', digest: previewDigest
  })).status, 303);

  const job = jobRow(h);
  const analyticsRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'analytics');
  const previewRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'pr_previews');
  const analytics = validateStoredOptionApproval(analyticsRow, {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  });
  const preview = validateStoredOptionApproval(previewRow, {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  });
  assert.equal(analytics.canActivate, false);
  assert.equal(preview.normalizedPayload.accessPolicyRequired, true);
  assert.equal(JSON.parse(analyticsRow.payload_json).canWrite, false);
  assert.equal(JSON.parse(previewRow.payload_json).plan.accessPolicyRequired, true);
  // Options storage must not PATCH Pages settings or touch analytics/preview APIs.
  assert.equal(h.calls.filter(c =>
    (c.method === 'PATCH' || c.method === 'PUT') &&
    /pages\/projects|analytics|preview_deployment/i.test(c.url)
  ).length, 0);
});
test('SEO and redirect opt-ins store without publishing files or Page Rules', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const { tenant, id } = await liveSite(h, t);

  const page = await (await h.request('/site-options?id=' + id, { cookie: tenant.cookie })).text();
  assert.match(page, /SEO starter/);
  assert.match(page, /Save a custom domain request first\. Redirects need that hostname/);

  const seoPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'seo', seoConsent: 'true'
  });
  assert.equal(seoPrep.status, 200);
  const seoDigest = (await seoPrep.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(seoDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'seo', seoConsent: 'true', digest: seoDigest
  })).status, 303);

  assert.equal((await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'redirects',
    hostname: 'www.example.com', redirectConsent: 'true', wwwMode: 'apex_to_www'
  })).status, 400);

  const domainPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com'
  });
  const domainDigest = (await domainPrep.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'domain', hostname: 'www.example.com', digest: domainDigest
  })).status, 303);

  const redirectPrep = await post(h, '/site-options-prepare', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'redirects',
    hostname: 'www.example.com', redirectConsent: 'true',
    wwwMode: 'apex_to_www', pathFrom: '/old', pathTo: '/new'
  });
  assert.equal(redirectPrep.status, 200);
  const redirectHtml = await redirectPrep.text();
  assert.match(redirectHtml, /No Page Rules|redirect request only/i);
  const redirectDigest = redirectHtml.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(redirectDigest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {
    csrf: tenant.csrf, id, kind: 'redirects',
    hostname: 'www.example.com', redirectConsent: 'true',
    wwwMode: 'apex_to_www', pathFrom: '/old', pathTo: '/new', digest: redirectDigest
  })).status, 303);

  const job = jobRow(h);
  const owner = {
    jobId: id,
    githubUserId: job.github_user_id,
    githubLogin: job.github_login,
    cloudflareAccountId: job.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: 'esp-' + job.site_slug + '-site'
  };
  const seoRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'seo');
  const redirectRow = h.sqlite.prepare(
    'SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?'
  ).get(id, 'redirects');
  assert.equal(validateStoredOptionApproval(seoRow, owner).canActivate, false);
  assert.equal(
    validateStoredOptionApproval(redirectRow, owner).normalizedPayload.wwwMode,
    'apex_to_www'
  );
  assert.equal(JSON.parse(seoRow.payload_json).canWrite, false);
  assert.equal(JSON.parse(redirectRow.payload_json).plan.proposed.premiumWafIncluded, false);
});

async function storeAnalytics(h, tenant, id) {
  const fields = {csrf: tenant.csrf, id, kind: 'analytics', analyticsConsent: 'true'};
  const prepared = await post(h, '/site-options-prepare', tenant.cookie, fields);
  assert.equal(prepared.status, 200);
  const digest = (await prepared.text()).match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  assert.equal((await post(h, '/site-options-approve', tenant.cookie, {...fields, digest})).status, 303);

  const page = await h.request('/site-options?id=' + id, {cookie: tenant.cookie});
  assert.equal(page.status, 200);
  const html = await page.text();
  const analyticsRequest = html.match(/name="analyticsRequest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(analyticsRequest);
  assert.match(html, /name="privacyBeaconConsent" value="true" required/);
  return {
    csrf: tenant.csrf,
    id,
    kind: 'analytics',
    intent: 'analytics-enablement-review',
    analyticsRequest,
    privacyBeaconConsent: 'true'
  };
}

const analyticsRow = h => h.sqlite.prepare(
  "SELECT * FROM onboarding_option_approvals WHERE kind = 'analytics'"
).get();
const reviewAnalytics = (h, tenant, fields) => post(h, '/site-options-prepare', tenant.cookie, fields);

test('current Analytics consent and a separate privacy acknowledgment yield a read-only review', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, id} = await liveSite(h, t);
  const initial = await h.request('/site-options?id=' + id, {cookie: tenant.cookie});
  assert.doesNotMatch(await initial.text(), /privacyBeaconConsent/);
  const fields = await storeAnalytics(h, tenant, id);
  const stored = analyticsRow(h);
  const callsBefore = h.calls.length;

  const denied = await reviewAnalytics(h, tenant, {...fields, privacyBeaconConsent: 'false'});
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /separate privacy and beacon/);
  assert.equal(h.calls.length, callsBefore);

  const forged = await reviewAnalytics(h, tenant, {...fields, csrf: 'invalid'});
  assert.equal(forged.status, 400);
  assert.equal(h.calls.length, callsBefore);

  const result = await reviewAnalytics(h, tenant, fields);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('cache-control'), /no-store/);
  const html = await result.text();
  assert.match(html, /Review Web Analytics enablement/);
  const proposalDigest = html.match(/Review fingerprint <code>([a-f0-9]{64})<\/code>/)?.[1];
  assert.ok(proposalDigest);
  assert.match(html, /next deployment/);
  assert.match(html, /separate operator grant/);
  assert.match(html, /Open Cloudflare project/);
  assert.doesNotMatch(html, /<form|cf_secret_example|ghu_secret_example|pages-stable-101/);
  assert.ok(!html.includes(stored.id));
  assert.deepEqual(analyticsRow(h), stored);

  const reads = h.calls.slice(callsBefore);
  assert.ok(reads.some(c => c.url === 'https://api.github.com/repos/tester/esp-willow-studio'));
  assert.ok(reads.some(c => c.url === 'https://api.cloudflare.com/client/v4/accounts/' + accountId +
    '/pages/projects/esp-willow-studio-site'));
  assert.ok(reads.every(c => c.method === 'GET'));

  const executeAttempt = await post(h, '/site-options-approve', tenant.cookie, {
    ...fields, digest: proposalDigest, analyticsConsent: 'true'
  });
  assert.equal(executeAttempt.status, 400);
  assert.deepEqual(analyticsRow(h), stored);
});

test('the Analytics review refuses a stale request with the same opt-in digest', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, id} = await liveSite(h, t);
  const stale = await storeAnalytics(h, tenant, id);
  const first = analyticsRow(h);
  const current = await storeAnalytics(h, tenant, id);
  const second = analyticsRow(h);
  assert.notEqual(first.id, second.id);
  assert.equal(first.approval_digest, second.approval_digest);
  assert.notEqual(stale.analyticsRequest, current.analyticsRequest);

  const callsBefore = h.calls.length;
  const response = await reviewAnalytics(h, tenant, stale);
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /Review fingerprint|Open Cloudflare project/);
  assert.equal(h.calls.length, callsBefore);

  const projectId = jobRow(h).pages_project_id;
  const replaceProject = h.sqlite.prepare('UPDATE onboarding_launch_jobs SET pages_project_id = ? WHERE id = ?');
  replaceProject.run('replacement-project', id);
  const replaced = await reviewAnalytics(h, tenant, current);
  assert.equal(replaced.status, 409);
  assert.doesNotMatch(await replaced.text(), /Review fingerprint|Open Cloudflare project/);
  assert.equal(h.calls.length, callsBefore);
  replaceProject.run(projectId, id);

  h.sqlite.prepare("UPDATE onboarding_option_approvals SET payload_json = '{}' WHERE kind = 'analytics'").run();
  const invalid = await reviewAnalytics(h, tenant, current);
  assert.equal(invalid.status, 409);
  assert.doesNotMatch(await invalid.text(), /Review fingerprint|Open Cloudflare project/);
  assert.equal(h.calls.length, callsBefore);
});

test('the Analytics review binds the current private repository and exact Pages project', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, id} = await liveSite(h, t);
  const fields = await storeAnalytics(h, tenant, id);
  const stored = analyticsRow(h);
  const site = h.resourceState;
  const originalRepoId = site.repo.id;
  site.repo.id = originalRepoId + 1;
  const wrongRepo = await reviewAnalytics(h, tenant, fields);
  assert.equal(wrongRepo.status, 409);
  assert.doesNotMatch(await wrongRepo.text(), /Review fingerprint|Open Cloudflare project/);
  site.repo.id = originalRepoId;

  const originalProjectId = site.pages.id;
  site.pages.id = 'replaced-project';
  const wrongProject = await reviewAnalytics(h, tenant, fields);
  assert.equal(wrongProject.status, 409);
  assert.doesNotMatch(await wrongProject.text(), /Review fingerprint|Open Cloudflare project/);
  site.pages.id = originalProjectId;

  site.pages.build_config.web_analytics_tag = 'provider-tag';
  const tagged = await reviewAnalytics(h, tenant, fields);
  assert.equal(tagged.status, 200);
  const taggedHtml = await tagged.text();
  assert.match(taggedHtml, /Verify the live beacon and traffic/);
  assert.doesNotMatch(taggedHtml, /Review fingerprint|provider-tag|<form/);
  assert.deepEqual(analyticsRow(h), stored);
});

test('another tenant cannot prepare an Analytics enablement review with a copied request', async (t) => {
  const h = harness();
  t.after(() => h.sqlite.close());
  const {tenant, id} = await liveSite(h, t);
  const fields = await storeAnalytics(h, tenant, id);
  h.resourceState.githubUserId = 99;
  const other = await connectTenant(h);
  const before = h.calls.length;
  const response = await reviewAnalytics(h, other, {...fields, csrf: other.csrf});
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /Review fingerprint|Open Cloudflare project/);
  assert.equal(h.calls.length, before);
});

for (const change of ['replace the stored request', 'log out']) {
  test('Analytics review is withheld when owners ' + change + ' during the final authorization await', async (t) => {
    const h = harness();
    t.after(() => h.sqlite.close());
    const {tenant, id} = await liveSite(h, t);
    const fields = await storeAnalytics(h, tenant, id);

    let reads = 0;
    let changeOnRead;
    const prepare = h.DB.prepare.bind(h.DB);
    t.mock.method(h.DB, 'prepare', sql => {
      const stmt = prepare(sql);
      if (!sql.includes("o.kind = 'analytics'") ||
          !sql.includes('JOIN onboarding_sessions s')) return stmt;
      return {...stmt, bind(...params) {
        const bound = stmt.bind(...params);
        return {...bound, async first() {
          reads += 1;
          if (reads === changeOnRead) {
            await Promise.resolve();
            if (change === 'log out')
              h.sqlite.prepare('DELETE FROM onboarding_sessions').run();
            else h.sqlite.prepare("UPDATE onboarding_option_approvals SET id = ? WHERE kind = 'analytics'")
              .run('99999999-9999-4999-8999-999999999999');
          }
          return bound.first();
        }};
      }};
    });
    const baseline = await reviewAnalytics(h, tenant, fields);
    assert.equal(baseline.status, 200);
    assert.match(await baseline.text(), /Review fingerprint/);
    assert.ok(reads >= 2);
    changeOnRead = reads;
    reads = 0;

    const raced = await reviewAnalytics(h, tenant, fields);
    assert.equal(raced.status, 409);
    assert.equal(reads, changeOnRead);
    assert.doesNotMatch(await raced.text(), /Review fingerprint|Open Cloudflare project/);
  });
}
