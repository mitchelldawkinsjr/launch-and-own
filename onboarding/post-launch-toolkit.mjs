/**
 * Owner-scoped post-launch toolkit projections (#87).
 * History-first: uses launch-job ownership checks. Provider-truth projection
 * lives in pipeline/toolkit-capabilities.mjs (#84); this module maps retained
 * job evidence onto the same capability state vocabulary without provider calls.
 */
import {getOwnedJob, listOwnedJobs, isLaunchId} from './launch-jobs.mjs';
import {TOOLKIT_CAPABILITY_STATES} from '../pipeline/toolkit-capabilities.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const STATES = new Set(TOOLKIT_CAPABILITY_STATES);

const STATUS_COPY = Object.freeze({
  live: {
    label: 'Live',
    detail: 'Launch & Own verified the public site against the approved revision.'
  },
  pending_deployment: {
    label: 'Publishing',
    detail: 'Your website is still deploying. It is not verified live yet.'
  },
  queued: {
    label: 'Queued',
    detail: 'Waiting to create your private GitHub repository and website.'
  },
  needs_reauthorization: {
    label: 'Reconnect required',
    detail: 'Sign in again with GitHub and Cloudflare, then reapprove to continue.'
  },
  failed: {
    label: 'Needs attention',
    detail: 'The last launch attempt stopped. Reconnect or contact support with the status code.'
  }
});

const CAP_LABELS = Object.freeze({
  static_hosting: 'Static hosting',
  https: 'HTTPS',
  deployment_health: 'Deployment health',
  website_updates: 'Safe website updates',
  web_analytics: 'Visitor insights',
  pr_previews: 'Private update previews',
  custom_domains: 'Custom domain',
  email_routing: 'Email forwarding',
  seo_bundle: 'SEO setup',
  contact_forms: 'Contact forms',
  advanced_services: 'Advanced services'
});

function cap(state, reason, detail) {
  if (!STATES.has(state)) throw new Error('unknown toolkit capability state');
  return Object.freeze({state, reason, detail});
}

/**
 * History-retained capability labels aligned with #84 states.
 * Live provider evidence still belongs to summarizeOwnedToolkitSite (#39 path).
 */
export function historyToolkitCapabilities({live = false, canEdit = false, uploadedZip = false} = {}) {
  const hosting = live
    ? cap('included_verified', 'verified_launch_job',
      'Customer-owned Cloudflare Pages from a verified launch in your history.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Hosting appears after Launch & Own verifies the public site.');
  const https = live
    ? cap('included_verified', 'verified_https_publication',
      'Public HTTPS was confirmed with the approved revision.')
    : cap('not_available', 'awaiting_public_https_verification',
      'HTTPS status waits on verified publication.');
  const health = live
    ? cap('included_verified', 'verified_launch_job',
      'Last successful verify for this retained launch record.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Deployment health is shown after a verified live check.');
  let updates;
  if (uploadedZip)
    updates = cap('not_available', 'uploaded_source_has_no_supported_editor',
      'Uploaded ZIP sites keep the GitHub workflow; the one-page editor does not apply.');
  else if (canEdit && live)
    updates = cap('available_opt_in', 'editor_eligible',
      'Edit → exact preview → approve → merge one GitHub update → we verify live.');
  else if (live)
    updates = cap('not_available', 'update_acceptance_pending',
      'This retained site is not eligible for the one-page editor yet.');
  else
    updates = cap('not_available', 'update_acceptance_pending',
      'Website updates unlock after the site is verified live.');

  return Object.freeze({
    static_hosting: hosting,
    https,
    deployment_health: health,
    website_updates: updates,
    web_analytics: cap('manual_setup', 'review_provider_settings',
      'Not configured here yet. Use Cloudflare Pages → Metrics → Web Analytics when ready (#85).'),
    pr_previews: cap('blocked_permission_or_plan', 'preview_access_and_approval_required',
      'GitHub PR previews stay off until you opt in; draft URLs can be public (#86).'),
    custom_domains: cap('manual_setup', 'verified_domain_setup_required',
      'Point a domain through your Cloudflare Pages project when you are ready.'),
    email_routing: cap('not_available', 'owned_custom_domain_needed',
      'Needs a custom domain and inbox you control.'),
    seo_bundle: cap('not_available', 'separate_reviewed_artifact_needed',
      'Extra SEO packaging is a separate reviewed update.'),
    contact_forms: cap('not_available', 'verified_server_form_integration_needed',
      'Forms need a separately approved delivery path.'),
    advanced_services: cap('not_available', 'separate_usage_and_approval_review_needed',
      'Workers, D1, KV, or R2 need a reviewed usage plan.')
  });
}

export function websiteUrlForSlug(siteSlug) {
  if (typeof siteSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug))
    return null;
  return 'https://esp-' + siteSlug + '-site.pages.dev/';
}

export function githubRepoUrl(githubLogin, siteSlug) {
  if (typeof githubLogin !== 'string' || typeof siteSlug !== 'string') return null;
  if (!/^[A-Za-z0-9-]{1,39}$/.test(githubLogin) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug))
    return null;
  return 'https://github.com/' + githubLogin + '/esp-' + siteSlug;
}

function planHasZip(planJson) {
  if (planJson == null) return false;
  try {
    const plan = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
    return plan && typeof plan === 'object' && plan.zip != null;
  } catch {
    return false;
  }
}

function unixStamp(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function formatWhen(unix) {
  if (!unix) return null;
  try {
    return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return null;
  }
}

/**
 * Plain-language ladder for post-approval update status (non-technical).
 * Closed-without-merge does not invite another Merge click.
 */
export function updatePublicationLadder({prStatus, verifyStatus = null}) {
  const steps = [
    Object.freeze({id: 'approved', title: 'Update approved', hint: 'Exact preview saved.'}),
    Object.freeze({
      id: 'merge',
      title: 'Publish in GitHub',
      hint: 'Open the update link and click Merge to put changes on your live site.'
    }),
    Object.freeze({
      id: 'publishing',
      title: 'Checking your live site',
      hint: 'Cloudflare is publishing. Refresh until we confirm the exact change.'
    }),
    Object.freeze({
      id: 'live',
      title: 'Live',
      hint: 'Public site matches the approved update.'
    })
  ];
  let current = 'merge';
  if (prStatus === 'closed-unmerged')
    current = 'closed';
  else if (prStatus === 'awaiting-customer-merge' || prStatus === 'open')
    current = 'merge';
  else if (prStatus === 'merged' && verifyStatus === 'live')
    current = 'live';
  else if (prStatus === 'merged')
    current = 'publishing';
  return Object.freeze({
    current,
    steps: Object.freeze(steps.map(step => Object.freeze({
      ...step,
      active: current === 'closed' ? step.id === 'approved' : step.id === current
    }))),
    primaryAction: current === 'merge'
      ? Object.freeze({
        label: 'Open update to publish',
        detail: 'GitHub shows your change. Click Merge when you are ready.'
      })
      : current === 'publishing'
        ? Object.freeze({
          label: 'Check again',
          detail: 'Publishing usually finishes in a few minutes.'
        })
        : current === 'closed'
          ? Object.freeze({
            label: 'Start a fresh edit',
            detail: 'That update was closed without publishing. Open Update this website for a new change.'
          })
          : Object.freeze({
            label: 'View live website',
            detail: 'Your approved update is verified on the public site.'
          })
  });
}

export function projectToolkitCard(job, {canEdit = false} = {}) {
  if (!job || !isLaunchId(job.id)) return null;
  const display = job.display_status || job.status;
  const copy = STATUS_COPY[display] || {
    label: String(display || 'Unknown'),
    detail: 'Status could not be classified; do not treat this as live.'
  };
  const live = display === 'live';
  const website = websiteUrlForSlug(job.site_slug);
  const repo = githubRepoUrl(job.github_login, job.site_slug);
  const commit = SHA.test(job.expected_commit_sha || '')
    ? String(job.expected_commit_sha).toLowerCase()
    : null;
  const digest = DIGEST.test(job.approval_digest || '')
    ? String(job.approval_digest).toLowerCase()
    : null;
  const verifiedAt = live ? unixStamp(job.approved_at) || unixStamp(job.updated_at) : null;
  const expiresAt = unixStamp(job.expires_at);
  const editable = Boolean(canEdit) && live;
  return Object.freeze({
    id: job.id,
    name: job.customer_name,
    status: display,
    statusLabel: copy.label,
    statusDetail: copy.detail,
    websiteUrl: live ? website : null,
    githubRepoUrl: repo,
    pagesProjectId: typeof job.pages_project_id === 'string' ? job.pages_project_id : null,
    productionCommitSha: live ? commit : null,
    approvedHtmlSha256: digest,
    verifiedAt,
    verifiedAtLabel: formatWhen(verifiedAt),
    expiresAt,
    expiresAtLabel: formatWhen(expiresAt),
    errorCode: typeof job.error_code === 'string' ? job.error_code : null,
    canEdit: editable,
    editPath: editable ? '/site-update?id=' + encodeURIComponent(job.id) : null,
    capabilities: historyToolkitCapabilities({
      live,
      canEdit: editable,
      uploadedZip: planHasZip(job.plan_json)
    })
  });
}

export async function loadToolkitCards(env, session, time) {
  const summaries = await listOwnedJobs(env, session, time);
  const cards = [];
  for (const summary of summaries) {
    const job = await getOwnedJob(env, session, summary.id, time);
    if (!job) continue;
    const card = projectToolkitCard(job, {canEdit: Number(summary.can_edit) === 1});
    if (card) cards.push(card);
  }
  return Object.freeze(cards);
}

/**
 * @param {object} ui {view, escape, button?}
 */
export function renderToolkitPage(cards, current, ui) {
  const {view, escape} = ui;
  if (!current?.cloudflare_account_id)
    return view('Your website toolkit',
      '<p>Connect GitHub and choose your Cloudflare account to see your sites.</p>' +
      '<p><a href="/">Back to setup</a></p>');
  const body = !cards.length
    ? '<p>No websites in your current launch history yet. Create or upload a site first.</p>'
    : cards.map(card => renderCard(card, escape)).join('');
  return view('Your website toolkit',
    '<p>A simple view of sites you own in Launch &amp; Own. Status comes from verified launch records — not guesses from chat.</p>' +
    '<p class="muted">History rows expire after about 30 days. Long-term inventory is tracked separately.</p>' +
    body +
    '<p><a href="/history">Launch history</a> · <a href="/">Back to setup</a></p>');
}

function renderCard(card, escape) {
  const live = card.websiteUrl
    ? '<p><a href="' + escape(card.websiteUrl) + '">' + escape(card.websiteUrl) + '</a></p>'
    : '';
  const repo = card.githubRepoUrl
    ? '<p>Private code: <a href="' + escape(card.githubRepoUrl) + '" rel="noopener">Open GitHub repository</a></p>'
    : '';
  const commit = card.productionCommitSha
    ? '<p>Verified revision: <code>' + escape(card.productionCommitSha) + '</code></p>'
    : '';
  const digest = card.approvedHtmlSha256
    ? '<p>Approved content fingerprint: <code>' + escape(card.approvedHtmlSha256.slice(0, 12)) + '…</code></p>'
    : '';
  const when = card.verifiedAtLabel
    ? '<p>Last verified: <time datetime="' + escape(card.verifiedAtLabel) + '">' +
      escape(card.verifiedAtLabel) + '</time></p>'
    : '';
  const expires = card.expiresAtLabel
    ? '<p class="muted">History retention until <time datetime="' + escape(card.expiresAtLabel) + '">' +
      escape(card.expiresAtLabel) + '</time></p>'
    : '';
  const err = card.errorCode
    ? '<p>Last result code: <code>' + escape(card.errorCode) + '</code></p>'
    : '';
  const edit = card.editPath
    ? '<p><a href="' + escape(card.editPath) + '">Update this website</a></p>'
    : '';
  const caps = Object.entries(card.capabilities).map(([id, item]) => {
    const label = CAP_LABELS[id] || id;
    return '<li><strong>' + escape(label) + '</strong> (' + escape(item.state) + '): ' +
      escape(item.detail) + '</li>';
  }).join('');
  return '<section><h2>' + escape(card.name) + '</h2>' +
    '<p class="pill">' + escape(card.statusLabel) + '</p>' +
    '<p>' + escape(card.statusDetail) + '</p>' +
    live + repo + commit + digest + when + expires + err + edit +
    '<details><summary>Toolkit capabilities</summary><ul>' + caps + '</ul></details>' +
    '</section>';
}

/**
 * HTML fragment for /site-update-status using the publication ladder.
 */
export function renderUpdateStatusBody({
  pr, verifyResult, approvedHtmlSha256, ticketRaw, escape
}) {
  const ladder = updatePublicationLadder({
    prStatus: pr.status,
    verifyStatus: verifyResult?.status || null
  });
  const steps = ladder.steps.map(step =>
    '<li' + (step.active ? '><strong>' : '>') + escape(step.title) +
    (step.active ? '</strong>' : '') +
    ' — ' + escape(step.hint) + '</li>'
  ).join('');
  const mergeCta = pr.pullRequest && ladder.current === 'merge'
    ? '<p><a class="btn-like" href="' + escape(pr.pullRequest) +
      '" rel="noopener"><strong>' + escape(ladder.primaryAction.label) +
      '</strong></a></p><p>' + escape(ladder.primaryAction.detail) + '</p>'
    : '';
  const liveLink = verifyResult?.status === 'live' && verifyResult.website
    ? '<p class="pill">Verified live</p><p><a href="' + escape(verifyResult.website) + '">' +
      escape(verifyResult.website) + '</a></p>'
    : ladder.current === 'publishing'
      ? '<p>' + escape(ladder.primaryAction.detail) + '</p>'
      : '';
  const closed = pr.status === 'closed-unmerged'
    ? '<p role="alert">' + escape(ladder.primaryAction.detail) + '</p>'
    : '';
  return '<ol>' + steps + '</ol>' + mergeCta + closed + liveLink +
    '<p><a href="/site-update-status?ticket=' + encodeURIComponent(ticketRaw) +
    '">Refresh status</a></p>' +
    '<p class="muted">Approved content fingerprint: <code>' +
    escape(String(approvedHtmlSha256 || '').slice(0, 16)) + '…</code></p>' +
    '<p><a href="/toolkit">Website toolkit</a> · <a href="/history">Launch history</a></p>';
}
