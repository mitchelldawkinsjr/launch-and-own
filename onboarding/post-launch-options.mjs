// Post-launch options screen: store digest-bound domain / email / forms /
// analytics / PR-preview / SEO / redirect approvals. Store-only unless an
// operator grant exists.
import {readCurrentRevision} from '../imported/revision.mjs';
import {contactFormSummary, detectContactForm} from './form-detection.mjs';
import {readFormService} from './form-service.mjs';
import { buildDomainApprovalReview } from '../pipeline/domain-approval-review.mjs';
import {
  buildEmailRoutingApprovalReview, ToolkitApprovalExecutionError
} from '../pipeline/approved-extension-consumer.mjs';
import {
  buildAnalyticsOptInReview, buildPreviewOptInReview,
  buildSeoOptInReview, buildRedirectOptInReview
} from '../pipeline/option-feature-review.mjs';
import { planCustomer } from '../pipeline/plan-customer.mjs';
import { getOwnedJob, hasCurrentOwnerSession, isLaunchId } from './launch-jobs.mjs';
import { createD1OptionExecutionStore, isOptionExecutionConfigured, optionExecutionSchemaReady } from './option-execution-store.mjs';
import { currentAnalyticsRequestFingerprint, reviewAnalyticsOptions } from './toolkit-analytics-options.mjs';

const DIGEST = /^[a-f0-9]{64}$/i;
const ANALYTICS_REVIEW = 'analytics-enablement-review';
const KINDS = new Set([
  'domain', 'email', 'forms', 'analytics', 'pr_previews', 'seo', 'redirects'
]);

const SCHEMA_PROBE = `SELECT id, job_id, github_user_id, cloudflare_account_id, kind,
  approval_digest, payload_json, status FROM onboarding_option_approvals LIMIT 0`;

export async function optionApprovalsReady(db) {
  try {
    await db.prepare(SCHEMA_PROBE).all();
    return true;
  } catch {
    return false;
  }
}

async function ownedLiveJob(env, current, id, time) {
  if (!current?.cloudflare_account_id || !isLaunchId(id)) return null;
  const job = await getOwnedJob(env, current, id, time);
  if (!job || job.status !== 'live') return null;
  if (job.github_user_id !== current.github_user_id ||
      job.cloudflare_account_id !== current.cloudflare_account_id) return null;
  return job;
}

export async function listOptionApprovals(env, jobId) {
  if (!isLaunchId(jobId)) return [];
  const result = await env.DB.prepare(
    `SELECT kind, approval_digest, payload_json, status, updated_at
     FROM onboarding_option_approvals WHERE job_id = ? ORDER BY kind`)
    .bind(jobId).all();
  return result.results || [];
}

async function storeOptionApproval(env, { job, session, kind, digest, payload, time }) {
  if (!KINDS.has(kind) || !DIGEST.test(digest)) return false;
  const id = crypto.randomUUID();
  const body = JSON.stringify(payload);
  const result = await env.DB.prepare(
    `INSERT INTO onboarding_option_approvals
      (id, job_id, github_user_id, cloudflare_account_id, kind, approval_digest,
       payload_json, status, created_at, updated_at)
     SELECT ?, j.id, j.github_user_id, j.cloudflare_account_id, ?, ?, ?, 'stored', ?, ?
     FROM onboarding_launch_jobs j
     WHERE j.id = ? AND j.github_user_id = ? AND j.cloudflare_account_id = ?
       AND j.status = 'live' AND j.expires_at > ?
       AND EXISTS (
         SELECT 1 FROM onboarding_sessions s WHERE s.id_hash = ? AND s.authorization_epoch = ?
           AND s.github_user_id = j.github_user_id AND s.cloudflare_account_id = j.cloudflare_account_id
           AND s.github_token_ct IS NOT NULL AND s.cloudflare_token_ct IS NOT NULL AND s.expires_at > ?
       )
     ON CONFLICT(job_id, kind) DO UPDATE SET
       id = excluded.id,
       approval_digest = excluded.approval_digest,
       payload_json = excluded.payload_json,
       status = 'stored',
       updated_at = excluded.updated_at
     WHERE onboarding_option_approvals.github_user_id = excluded.github_user_id
       AND onboarding_option_approvals.cloudflare_account_id = excluded.cloudflare_account_id`)
    .bind(id, kind, digest.toLowerCase(), body, time, time,
      job.id, session.github_user_id, session.cloudflare_account_id, time,
      session.hash, session.authorization_epoch, time).run();
  return result.meta.changes === 1;
}

function domainReview(job, session, hostname) {
  return buildDomainApprovalReview({
    cloudflareAccountId: job.cloudflare_account_id,
    githubUserId: session.github_user_id,
    hostname,
    domainConsent: true
  });
}

function emailReview(job, session, hostname, mailbox) {
  return buildEmailRoutingApprovalReview({
    cloudflareAccountId: job.cloudflare_account_id,
    githubUserId: session.github_user_id,
    hostname,
    mailbox
  });
}

function formsReviewFor(job, ownerEmail) {
  return planCustomer({
    name: job.customer_name,
    accountId: job.cloudflare_account_id,
    githubOwner: job.github_login,
    forms: true,
    formsConsent: true,
    ownerEmail
  }).formsReview;
}

function pagesProjectName(job) {
  return 'esp-' + job.site_slug + '-site';
}

function analyticsReview(job, session) {
  return buildAnalyticsOptInReview({
    cloudflareAccountId: job.cloudflare_account_id,
    githubUserId: session.github_user_id,
    pagesProjectName: pagesProjectName(job),
    analyticsConsent: true
  });
}

function previewReview(job, session) {
  return buildPreviewOptInReview({
    cloudflareAccountId: job.cloudflare_account_id,
    githubUserId: session.github_user_id,
    pagesProjectName: pagesProjectName(job),
    previewConsent: true,
    acknowledgePublicPreviews: true
  });
}

function seoReview(job, session) {
  return buildSeoOptInReview({
    cloudflareAccountId: job.cloudflare_account_id,
    githubUserId: session.github_user_id,
    pagesProjectName: pagesProjectName(job),
    seoConsent: true
  });
}

function redirectReview(job, session, hostname, form) {
  return buildRedirectOptInReview({
    cloudflareAccountId: job.cloudflare_account_id,
    githubUserId: session.github_user_id,
    hostname,
    redirectConsent: true,
    wwwMode: form.get('wwwMode') || 'none',
    pathFrom: form.get('pathFrom') || '',
    pathTo: form.get('pathTo') || ''
  });
}

function storedDomainHostname(rows) {
  const row = rows.find(item => item.kind === 'domain' && item.status === 'stored');
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json);
    const host = payload?.plan?.hostname;
    return typeof host === 'string' ? host : null;
  } catch {
    return null;
  }
}

// Suggest the contact email only when it passes the exact forwarding review.
function onboardingMailbox(job, current, host) {
  if (!host) return '';
  try {
    const email = JSON.parse(job.plan_json)?.site?.contactEmail;
    return typeof email === 'string' ? emailReview(job, current, host, email.trim()).plan.mailbox : '';
  } catch {
    return '';
  }
}

function buildReview(job, current, kind, form, rows) {
  if (kind === 'domain') {
    const review = domainReview(job, current, form.get('hostname'));
    if (review.status !== 'awaiting_domain_approval' || !review.approvalDigest)
      return { error: 'Enter a valid custom hostname you control.' };
    return {
      review,
      summary: 'Hostname <code>' + review.plan.hostname + '</code>. DNS stays unchanged.',
      fields: { hostname: review.plan.hostname }
    };
  }
  if (kind === 'email') {
    const host = storedDomainHostname(rows);
    if (!host) return { error: 'Save a custom domain request before email forwarding.' };
    if (form.get('hostname') !== host)
      return { error: 'Email forwarding must use the stored custom hostname.' };
    let review;
    try {
      // Bind the exact mailbox into a distinct email digest. The domain planner
      // does not hash the destination, so it cannot authorize a routing rule.
      review = emailReview(job, current, host, form.get('mailbox'));
    } catch (error) {
      if (error instanceof ToolkitApprovalExecutionError)
        return { error: 'Forward to an existing mailbox off the site hostname.' };
      throw error;
    }
    if (review.status !== 'awaiting_email_approval' || !review.approvalDigest ||
        review.plan?.kind !== 'launch-and-own-email-routing-approval' ||
        review.mxWriteAuthorized !== false)
      return { error: 'Forward to an existing mailbox off the site hostname.' };
    return {
      review,
      summary: 'Forward <code>' + review.plan.alias + '</code> to an existing mailbox. MX stays unchanged.',
      fields: { hostname: host, mailbox: review.plan.mailbox }
    };
  }
  if (kind === 'forms') {
    if (form.get('formsConsent') !== 'true')
      return { error: 'Confirm the form plan consent checkbox.' };
    let review;
    try {
      review = formsReviewFor(job, form.get('ownerEmail'));
    } catch {
      return { error: 'Enter a valid owner email for the form plan.' };
    }
    if (!review || review.status === 'blocked' || !review.approvalDigest ||
        review.workingForm !== false || review.createResources !== false)
      return { error: 'The form plan is not ready to store.' };
    return {
      review,
      summary: 'Siteverify-bound form plan. No widget, D1 database, or Worker is created.',
      fields: { ownerEmail: form.get('ownerEmail'), formsConsent: 'true' }
    };
  }
  if (kind === 'analytics') {
    if (form.get('analyticsConsent') !== 'true')
      return { error: 'Confirm the visitor insights consent checkbox.' };
    const review = analyticsReview(job, current);
    if (review.status !== 'awaiting_analytics_opt_in' || !review.approvalDigest)
      return { error: 'Visitor insights request is not ready to store.' };
    return {
      review,
      summary: 'Visitor insights request only. No analytics beacon is enabled yet.',
      fields: { analyticsConsent: 'true' }
    };
  }
  if (kind === 'pr_previews') {
    if (form.get('previewConsent') !== 'true')
      return { error: 'Confirm the preview opt-in checkbox.' };
    if (form.get('acknowledgePublicPreviews') !== 'true')
      return { error: 'Acknowledge that draft preview links can be public.' };
    const review = previewReview(job, current);
    if (review.status !== 'awaiting_preview_opt_in' || !review.approvalDigest)
      return { error: 'Preview request is not ready to store.' };
    return {
      review,
      summary: 'Scoped PR preview request only. Preview builds stay off until Access is reviewed.',
      fields: { previewConsent: 'true', acknowledgePublicPreviews: 'true' }
    };
  }
  if (kind === 'seo') {
    if (form.get('seoConsent') !== 'true')
      return { error: 'Confirm the SEO consent checkbox.' };
    const review = seoReview(job, current);
    if (review.status !== 'awaiting_seo_opt_in' || !review.approvalDigest)
      return { error: 'SEO request is not ready to store.' };
    return {
      review,
      summary: 'SEO starter request only. No HTML, robots.txt, or sitemap changes are published.',
      fields: { seoConsent: 'true' }
    };
  }
  if (kind === 'redirects') {
    const host = storedDomainHostname(rows);
    if (!host) return { error: 'Save a custom domain request before redirects.' };
    if (form.get('hostname') !== host)
      return { error: 'Redirects must use the stored custom hostname.' };
    if (form.get('redirectConsent') !== 'true')
      return { error: 'Confirm the redirects consent checkbox.' };
    const review = redirectReview(job, current, host, form);
    if (review.status !== 'awaiting_redirect_opt_in' || !review.approvalDigest)
      return { error: 'Enter a same-host www preference or path redirect.' };
    return {
      review,
      summary: 'Same-host redirect request only. No Page Rules or DNS changes are applied.',
      fields: {
        hostname: host,
        redirectConsent: 'true',
        wwwMode: review.plan.proposed.wwwMode,
        pathFrom: form.get('pathFrom') || '',
        pathTo: form.get('pathTo') || ''
      }
    };
  }
  return { error: 'Unknown optional feature.' };
}

export function createSiteOptionsRoutes({
  view, fail, button, escape, formData, assertCsrf, baseUrl, limitAttempts, assertHistoryAccess, now
}) {
  async function requireReady(env) {
    if (!await optionApprovalsReady(env.DB))
      return fail('Optional feature approvals are not enabled on this deployment yet.', 503);
    return null;
  }

  async function page(env, current, id) {
    const blocked = await requireReady(env);
    if (blocked) return blocked;
    const time = now();
    const job = await ownedLiveJob(env, current, id, time);
    if (!job) return fail('Open an owned, verified live website from your toolkit.', 404);
    const grants = await assertHistoryAccess(env, current);
    const rows = await listOptionApprovals(env, job.id);
    const byKind = Object.fromEntries(rows.map(row => [row.kind, row]));
    // A stored review is NOT an operator approval. Display activation only for
    // an independently granted, still-valid exact execution snapshot.
    const activations = {};
    if (isOptionExecutionConfigured(env) && await optionExecutionSchemaReady(env.DB)) {
      const available = await env.DB.prepare(
        "SELECT x.id, x.kind FROM onboarding_option_executions x " +
        "JOIN onboarding_option_approvals o ON o.id = x.option_approval_id " +
        "WHERE x.job_id = ? AND x.github_user_id = ? AND x.cloudflare_account_id = ? " +
        "AND x.authorization_epoch = ? AND x.status = 'approved' AND x.expires_at > ? " +
        "AND x.kind = o.kind AND x.approval_digest = o.approval_digest " +
        "AND x.repository_id = ? AND x.pages_project_id = ? " +
        "AND x.expected_commit_sha = ? AND o.status = 'stored' LIMIT 3"
      ).bind(job.id, current.github_user_id, current.cloudflare_account_id,
        current.authorization_epoch, time, job.repository_id,
        job.pages_project_id, job.expected_commit_sha).all();
      const reader = createD1OptionExecutionStore(env, current).approvalStore;
      for (const entry of available.results || []) {
        if (!['domain', 'email'].includes(entry.kind)) continue;
        if (env[entry.kind === 'domain' ? 'OPTION_DOMAIN_ENABLED' : 'OPTION_EMAIL_ENABLED'] !== 'true')
          continue;
        if (await reader.readApproved({
          id: entry.id, githubUserId: current.github_user_id,
          cloudflareAccountId: current.cloudflare_account_id
        })) activations[entry.kind] = entry.id;
      }
    }
    const activate = (kind, label) => activations[kind]
      ? button('/site-options-execute', label, current.csrf,
          '<input type="hidden" name="id" value="' + escape(activations[kind]) + '">')
      : '';
    const domainHost = storedDomainHostname(rows);
    const mailboxDefault = onboardingMailbox(job, current, domainHost);
    const website = 'https://esp-' + escape(job.site_slug) + '-site.pages.dev';
    const notice = '<p>Each request below is saved for review. We set it up after that review, and you approve each change before it happens. Until then your site, domain and email stay exactly as they are.</p>';
    const stored = (row, label) => row
      ? '<p role="status">Stored ' + label + ' request. Fingerprint <code>' +
        escape(row.approval_digest.slice(0, 12)) + '…</code></p>'
      : '';
    const domainSection =
      '<section><h2>Custom domain</h2>' +
      '<p>Enter a web address you own. We connect it after a review. Your DNS does not change until you approve that step.</p>' +
      stored(byKind.domain, 'domain') +
      (domainHost ? '<p>Current request: <code>' + escape(domainHost) + '</code></p>' : '') +
      button('/site-options-prepare', 'Review domain request', current.csrf,
        hidden(job.id, 'domain') +
        '<label for="opt-hostname">Hostname</label>' +
        '<input id="opt-hostname" name="hostname" required maxlength="253" ' +
        'placeholder="www.example.com" value="' + escape(domainHost || '') + '">') +
      activate('domain', 'Apply operator-approved domain') +
      '</section>';
    const emailSection =
      '<section><h2>Email forwarding</h2>' +
      (domainHost
        ? '<p>Forward mail for <code>' + escape(domainHost) +
          '</code> to a mailbox you already have. We set it up after a review. No new mailbox is created, and your mail settings stay the same until you approve.</p>' +
          stored(byKind.email, 'email') +
          button('/site-options-prepare', 'Review email request', current.csrf,
            hidden(job.id, 'email') +
            '<input type="hidden" name="hostname" value="' + escape(domainHost) + '">' +
            '<label for="opt-mailbox">Existing mailbox</label>' +
            '<input id="opt-mailbox" name="mailbox" type="email" required maxlength="254" ' +
            'placeholder="you@elsewhere.com" value="' + escape(mailboxDefault) + '">')
        : '<p>Save a custom domain request first. Email forwarding needs that hostname.</p>') +
      activate('email', 'Apply operator-approved email routing') +
      '</section>';
    // Read-only look at the current files so the request names the form it will connect.
    let formNote = '';
    try {
      const revision = await readCurrentRevision({owner: job.github_login, repo: 'esp-' + job.site_slug,
        token: grants?.githubAccessToken, fetchFn: (url, options) => fetch(url, {...options, signal: AbortSignal.timeout(8000)})});
      formNote = contactFormSummary(detectContactForm(revision.files), escape);
    } catch {
      formNote = '';
    }
    const formService = await readFormService(env, current, job.id);
    const connectLink = formService
      ? '<p role="status">Your form service is set up. <a href="/form-connect?id=' + encodeURIComponent(job.id) +
        '">Connect your contact form</a> to start receiving messages.</p>'
      : '';
    const formsSection =
      '<section><h2>Contact form</h2>' + formNote + connectLink +
      '<p>Connect your site\'s contact form so messages are saved in your own Cloudflare account, with spam protection. We set it up after a cost and privacy review.</p>' +
      stored(byKind.forms, 'form') +
      button('/site-options-prepare', 'Review form request', current.csrf,
        hidden(job.id, 'forms') +
        '<label for="opt-owner-email">Owner email for the form plan</label>' +
        '<input id="opt-owner-email" name="ownerEmail" type="email" required maxlength="254">' +
        '<label><input type="checkbox" name="formsConsent" value="true" required> ' +
        'Save this request for review. The form starts saving messages once it is set up and you approve it.</label>') +
      '</section>';
    const analyticsRequest = byKind.analytics?.status === 'stored'
      ? await currentAnalyticsRequestFingerprint(env, current, job, now())
      : null;
    const analyticsSection =
      '<section><h2>Visitor insights</h2>' +
      '<p>New sites launch with visitor insights on. If this site launched without them, save a request to turn them on.</p>' +
      stored(byKind.analytics, 'visitor insights') +
      button('/site-options-prepare', 'Review visitor insights request', current.csrf,
        hidden(job.id, 'analytics') +
        '<label><input type="checkbox" name="analyticsConsent" value="true" required> ' +
        'Save this request for review. Visitor insights start after you approve the change.</label>') +
      (analyticsRequest
        ? '<p>Review Web Analytics separately. Enabling it can add a browser beacon on the next deployment.</p>' +
          button('/site-options-prepare', 'Review Web Analytics enablement', current.csrf,
            hidden(job.id, 'analytics') +
            '<input type="hidden" name="intent" value="' + ANALYTICS_REVIEW + '">' +
            '<input type="hidden" name="analyticsRequest" value="' + escape(analyticsRequest) + '">' +
            '<label><input type="checkbox" name="privacyBeaconConsent" value="true" required> ' +
            'I have reviewed my privacy notice and understand the next deployment may add a beacon ' +
            'that collects visitor and performance data.</label>')
        : '') +
      '</section>';
    const previewSection =
      '<section><h2>Private update previews</h2>' +
      '<p>Save a request for scoped GitHub PR preview builds. Draft preview links can be public, so Access must be reviewed before enablement.</p>' +
      stored(byKind.pr_previews, 'preview') +
      button('/site-options-prepare', 'Review preview request', current.csrf,
        hidden(job.id, 'pr_previews') +
        '<label><input type="checkbox" name="previewConsent" value="true" required> ' +
        'Save this request for review. Previews start after setup and your approval.</label>' +
        '<label><input type="checkbox" name="acknowledgePublicPreviews" value="true" required> ' +
        'I understand draft preview links can be public until Access protects them.</label>') +
      '</section>';
    const seoSection =
      '<section><h2>SEO starter</h2>' +
      '<p>Save a request for search basics: canonical links, social previews, robots.txt and a sitemap. Your site files change only after you approve the update.</p>' +
      stored(byKind.seo, 'SEO') +
      button('/site-options-prepare', 'Review SEO request', current.csrf,
        hidden(job.id, 'seo') +
        '<label><input type="checkbox" name="seoConsent" value="true" required> ' +
        'Save this request for review.</label>') +
      '</section>';
    const redirectsSection =
      '<section><h2>Redirects</h2>' +
      (domainHost
        ? '<p>Same-host redirects for <code>' + escape(domainHost) +
          '</code>. We set them up after a review and your approval.</p>' +
          stored(byKind.redirects, 'redirect') +
          button('/site-options-prepare', 'Review redirect request', current.csrf,
            hidden(job.id, 'redirects') +
            '<input type="hidden" name="hostname" value="' + escape(domainHost) + '">' +
            '<label for="opt-www-mode">Apex / www preference</label>' +
            '<select id="opt-www-mode" name="wwwMode">' +
            '<option value="none">No apex/www preference</option>' +
            '<option value="apex_to_www">Prefer www</option>' +
            '<option value="www_to_apex">Prefer apex</option></select>' +
            '<label for="opt-path-from">Optional path from</label>' +
            '<input id="opt-path-from" name="pathFrom" maxlength="200" placeholder="/old">' +
            '<label for="opt-path-to">Optional path to</label>' +
            '<input id="opt-path-to" name="pathTo" maxlength="200" placeholder="/new">' +
            '<label><input type="checkbox" name="redirectConsent" value="true" required> ' +
            'Save these redirects for review.</label>')
        : '<p>Save a custom domain request first. Redirects need that hostname.</p>') +
      '</section>';
    if (!await hasCurrentOwnerSession(env, current, now()))
      return fail('Reconnect GitHub and Cloudflare to view your site options.', 403);
    return view('Optional features for ' + job.customer_name,
      notice +
      '<p><strong>Site:</strong> <code>' + website + '</code></p>' +
      domainSection + emailSection + formsSection + analyticsSection + previewSection +
      seoSection + redirectsSection +
      '<p><a href="/toolkit">Back to toolkit</a> · <a href="/history">Launch history</a></p>');
  }

  function hidden(id, kind) {
    return '<input type="hidden" name="id" value="' + escape(id) + '">' +
      '<input type="hidden" name="kind" value="' + escape(kind) + '">';
  }

  async function prepare(request, env, current) {
    await limitAttempts(request, env);
    const blocked = await requireReady(env);
    if (blocked) return blocked;
    const form = await formData(request);
    assertCsrf(request, form, current, baseUrl(env));
    const time = now();
    const id = form.get('id');
    const kind = form.get('kind');
    if (!KINDS.has(kind) || form.getAll('kind').length !== 1 || form.getAll('id').length !== 1)
      return fail('This options form is incomplete.');
    const job = await ownedLiveJob(env, current, id, time);
    if (!job) return fail('Open an owned, verified live website from your toolkit.', 404);
    if (form.has('intent')) {
      if (kind !== 'analytics' || form.getAll('intent').length !== 1 ||
          form.get('intent') !== ANALYTICS_REVIEW)
        return fail('This options form is incomplete.');
      return analyticsEnablementReview(env, current, job, form);
    }
    await assertHistoryAccess(env, current);
    const rows = await listOptionApprovals(env, job.id);
    const built = buildReview(job, current, kind, form, rows);
    if (built.error) return fail(built.error);
    if (!await hasCurrentOwnerSession(env, current, now()))
      return fail('Reconnect to review this options request.', 401);
    const extras = Object.entries(built.fields).map(([name, value]) =>
      '<input type="hidden" name="' + escape(name) + '" value="' + escape(value) + '">').join('');
    return view('Confirm optional feature request',
      '<p>' + built.summary + '</p>' +
      '<p>Approval fingerprint <code>' + escape(built.review.approvalDigest) + '</code></p>' +
      '<p>Confirming stores this request only. No DNS, mail, or form resources are created.</p>' +
      button('/site-options-approve', 'Store this request', current.csrf,
        hidden(job.id, kind) + extras +
        '<input type="hidden" name="digest" value="' + escape(built.review.approvalDigest) + '">') +
      '<p><a href="/site-options?id=' + encodeURIComponent(job.id) + '">Back</a></p>');
  }

  async function analyticsEnablementReview(env, current, job, form) {
    if (form.getAll('privacyBeaconConsent').length !== 1 ||
        form.get('privacyBeaconConsent') !== 'true')
      return fail('Confirm the separate privacy and beacon acknowledgment.');
    const fingerprint = form.get('analyticsRequest');
    if (form.getAll('analyticsRequest').length !== 1 || !DIGEST.test(fingerprint || ''))
      return fail('Reload your site options to review the current Analytics request.', 409);

    const review = await reviewAnalyticsOptions(env, current, job, {
      fingerprint, privacyBeaconConsent: true, now, assertHistoryAccess
    });
    const back = '<p><a href="/site-options?id=' + encodeURIComponent(job.id) + '">Back to site options</a></p>';
    if (review.status === 'manual-review-required')
      return view('Review existing Web Analytics settings',
        '<p>Cloudflare reports Web Analytics configuration. Verify the live beacon and traffic in Cloudflare.</p>' + back);
    if (review.status !== 'review-required')
      return fail('Could not verify the current Analytics request and Pages project. Reopen your site options.', 409);

    return view('Review Web Analytics enablement',
      '<p>Pages project <code>' + escape(review.binding.pagesProjectName) + '</code></p>' +
      '<p>Review fingerprint <code>' + escape(review.proposalSha256) + '</code></p>' +
      '<p>Enabling Web Analytics may add a browser beacon on the next deployment. ' +
      'Approval from the site owner and a separate operator grant are required before activation. ' +
      'Review and approve any production deployment separately.</p>' +
      '<p><a href="' + escape(review.projectDashboardUrl) + '" rel="noreferrer">Open Cloudflare project</a> ' +
      'and choose Metrics to review its settings.</p>' + back);
  }

  async function approve(request, env, current) {
    await limitAttempts(request, env);
    const blocked = await requireReady(env);
    if (blocked) return blocked;
    const form = await formData(request);
    assertCsrf(request, form, current, baseUrl(env));
    const time = now();
    const id = form.get('id');
    const kind = form.get('kind');
    const posted = form.get('digest');
    if (form.has('intent') || !KINDS.has(kind) || form.getAll('kind').length !== 1 ||
        form.getAll('id').length !== 1 || form.getAll('digest').length !== 1 ||
        !DIGEST.test(posted || ''))
      return fail('This options form is incomplete.');
    const job = await ownedLiveJob(env, current, id, time);
    if (!job) return fail('Open an owned, verified live website from your toolkit.', 404);
    await assertHistoryAccess(env, current);
    const rows = await listOptionApprovals(env, job.id);
    const built = buildReview(job, current, kind, form, rows);
    if (built.error) return fail(built.error);
    if (posted.toLowerCase() !== built.review.approvalDigest)
      return fail('This options request changed. Reload and try again.');
    const saved = await storeOptionApproval(env, {
      job, session: current, kind, digest: built.review.approvalDigest,
      payload: built.review, time: now()
    });
    if (!saved) return fail('Could not store this options request. Reload and try again.', 409);
    return Response.redirect(baseUrl(env) + '/site-options?id=' + encodeURIComponent(job.id), 303);
  }

  return { page, prepare, approve };
}

/** Toolkit card link for live owned sites. */
export function optionsPathForJob(jobId, status) {
  if (status !== 'live' || !isLaunchId(jobId)) return null;
  return '/site-options?id=' + encodeURIComponent(jobId);
}
