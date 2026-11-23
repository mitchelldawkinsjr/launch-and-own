// Post-launch options screen: store digest-bound domain / email / forms approvals.
// Never calls Cloudflare or GitHub. Never writes DNS, MX, Turnstile, D1, or Workers.
import { buildDomainApprovalReview } from '../pipeline/domain-approval-review.mjs';
import {
  buildEmailRoutingApprovalReview, ToolkitApprovalExecutionError
} from '../pipeline/approved-extension-consumer.mjs';
import { planCustomer } from '../pipeline/plan-customer.mjs';
import {
  applyStoredDomainOption, blockedOptionApplyReason
} from './apply-stored-options.mjs';
import { getOwnedJob, hasCurrentOwnerSession, isLaunchId } from './launch-jobs.mjs';

const DIGEST = /^[a-f0-9]{64}$/i;
const KINDS = new Set(['domain', 'email', 'forms']);

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
  if (!await hasCurrentOwnerSession(env, session, time)) return false;
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
     ON CONFLICT(job_id, kind) DO UPDATE SET
       id = excluded.id,
       approval_digest = excluded.approval_digest,
       payload_json = excluded.payload_json,
       status = 'stored',
       updated_at = excluded.updated_at
     WHERE onboarding_option_approvals.github_user_id = excluded.github_user_id
       AND onboarding_option_approvals.cloudflare_account_id = excluded.cloudflare_account_id`)
    .bind(id, kind, digest.toLowerCase(), body, time, time,
      job.id, session.github_user_id, session.cloudflare_account_id, time).run();
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
    await assertHistoryAccess(env, current);
    const rows = await listOptionApprovals(env, job.id);
    const byKind = Object.fromEntries(rows.map(row => [row.kind, row]));
    const domainHost = storedDomainHostname(rows);
    const website = 'https://esp-' + escape(job.site_slug) + '-site.pages.dev';
    const notice = '<p>Store each request first. Attaching a custom domain uses your Cloudflare account for that exact stored hostname. Email MX changes and form Workers stay blocked until their separate gates are met.</p>';
    const stored = (row, label) => row
      ? '<p role="status">Stored ' + label + ' request. Fingerprint <code>' +
        escape(row.approval_digest.slice(0, 12)) + '…</code></p>'
      : '';
    const domainApply = byKind.domain
      ? button('/site-options-apply', 'Attach stored domain to Pages', current.csrf,
        hidden(job.id, 'domain') +
        '<input type="hidden" name="digest" value="' + escape(byKind.domain.approval_digest) + '">')
      : '';
    const domainSection =
      '<section><h2>Custom domain</h2>' +
      '<p>Enter the hostname you control. Attach only after the request is stored.</p>' +
      stored(byKind.domain, 'domain') +
      (domainHost ? '<p>Current request: <code>' + escape(domainHost) + '</code></p>' : '') +
      button('/site-options-prepare', 'Review domain request', current.csrf,
        hidden(job.id, 'domain') +
        '<label for="opt-hostname">Hostname</label>' +
        '<input id="opt-hostname" name="hostname" required maxlength="253" ' +
        'placeholder="www.example.com" value="' + escape(domainHost || '') + '">') +
      domainApply +
      '</section>';
    const emailSection =
      '<section><h2>Email forwarding</h2>' +
      (domainHost
        ? '<p>Forward to an existing mailbox off <code>' + escape(domainHost) +
          '</code>. Rule create never writes MX and stays blocked until Email Routing is already ready.</p>' +
          stored(byKind.email, 'email') +
          button('/site-options-prepare', 'Review email request', current.csrf,
            hidden(job.id, 'email') +
            '<input type="hidden" name="hostname" value="' + escape(domainHost) + '">' +
            '<label for="opt-mailbox">Existing mailbox</label>' +
            '<input id="opt-mailbox" name="mailbox" type="email" required maxlength="254" ' +
            'placeholder="you@elsewhere.com">') +
          (byKind.email
            ? button('/site-options-apply', 'Apply stored email request', current.csrf,
              hidden(job.id, 'email') +
              '<input type="hidden" name="digest" value="' + escape(byKind.email.approval_digest) + '">')
            : '')
        : '<p>Save a custom domain request first. Email forwarding needs that hostname.</p>') +
      '</section>';
    const formsSection =
      '<section><h2>Contact form</h2>' +
      '<p>Reviews a Siteverify-bound form plan only. Worker create stays blocked until a #89 cost and privacy approval exists.</p>' +
      stored(byKind.forms, 'form') +
      button('/site-options-prepare', 'Review form request', current.csrf,
        hidden(job.id, 'forms') +
        '<label for="opt-owner-email">Owner email for the form plan</label>' +
        '<input id="opt-owner-email" name="ownerEmail" type="email" required maxlength="254">' +
        '<label><input type="checkbox" name="formsConsent" value="true" required> ' +
        'I want a separate form plan reviewed later. This does not create a working form.</label>') +
      (byKind.forms
        ? button('/site-options-apply', 'Apply stored form request', current.csrf,
          hidden(job.id, 'forms') +
          '<input type="hidden" name="digest" value="' + escape(byKind.forms.approval_digest) + '">')
        : '') +
      '</section>';
    return view('Optional features for ' + job.customer_name,
      notice +
      '<p><strong>Site:</strong> <code>' + website + '</code></p>' +
      domainSection + emailSection + formsSection +
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
    await assertHistoryAccess(env, current);
    const rows = await listOptionApprovals(env, job.id);
    const built = buildReview(job, current, kind, form, rows);
    if (built.error) return fail(built.error);
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
    if (!KINDS.has(kind) || form.getAll('kind').length !== 1 ||
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
      payload: built.review, time
    });
    if (!saved) return fail('Could not store this options request. Reload and try again.', 409);
    return Response.redirect(baseUrl(env) + '/site-options?id=' + encodeURIComponent(job.id), 303);
  }

  async function apply(request, env, current) {
    await limitAttempts(request, env);
    const blocked = await requireReady(env);
    if (blocked) return blocked;
    const form = await formData(request);
    assertCsrf(request, form, current, baseUrl(env));
    const time = now();
    const id = form.get('id');
    const kind = form.get('kind');
    const posted = form.get('digest');
    if (!KINDS.has(kind) || form.getAll('kind').length !== 1 ||
        form.getAll('id').length !== 1 || form.getAll('digest').length !== 1 ||
        !DIGEST.test(posted || ''))
      return fail('This options form is incomplete.');
    const job = await ownedLiveJob(env, current, id, time);
    if (!job) return fail('Open an owned, verified live website from your toolkit.', 404);
    await assertHistoryAccess(env, current);
    const rows = await listOptionApprovals(env, job.id);
    const row = rows.find(item => item.kind === kind && item.status === 'stored');
    if (!row || row.approval_digest.toLowerCase() !== posted.toLowerCase())
      return fail('Store a matching options request before applying it.');

    if (kind === 'email' || kind === 'forms')
      return fail(blockedOptionApplyReason(kind));

    // Load the full D1 row for validation (list query is a projection).
    const full = await env.DB.prepare(
      `SELECT id, job_id, github_user_id, cloudflare_account_id, kind, approval_digest,
              payload_json, status FROM onboarding_option_approvals
       WHERE job_id = ? AND kind = ? AND status = 'stored'`)
      .bind(job.id, kind).first();
    if (!full || full.approval_digest.toLowerCase() !== posted.toLowerCase())
      return fail('Store a matching options request before applying it.');

    try {
      const result = await applyStoredDomainOption(env, {
        job, session: current, row: full, assertHistoryAccess, now
      });
      return view('Custom domain attach result',
        '<p role="status">Hostname <code>' + escape(result.hostname) + '</code> is ' +
        escape(result.status.replaceAll('_', ' ')) + '.</p>' +
        '<p>Platform DNS and MX were not changed. Cloudflare may create DNS in your own zone.</p>' +
        '<p><a href="/site-options?id=' + encodeURIComponent(job.id) + '">Back to options</a></p>');
    } catch (error) {
      return fail(error?.message || 'Could not attach the stored domain.', 409);
    }
  }

  return { page, prepare, approve, apply };
}

/** Toolkit card link for live owned sites. */
export function optionsPathForJob(jobId, status) {
  if (status !== 'live' || !isLaunchId(jobId)) return null;
  return '/site-options?id=' + encodeURIComponent(jobId);
}
