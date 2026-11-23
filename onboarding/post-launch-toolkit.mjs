/** Owner-scoped launch history and update status views (#87). */
import {hasCurrentOwnerSession, isLaunchId, listOwnedJobs} from './launch-jobs.mjs';
import {optionsPathForJob} from './post-launch-options.mjs';
import {TOOLKIT_CAPABILITY_STATES} from '../pipeline/toolkit-capabilities.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const STATES = new Set(TOOLKIT_CAPABILITY_STATES);

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
 * History-retained labels using #84 states. Live provider evidence stays with
 * summarizeOwnedToolkitSite once #39 owned-site reads exist.
 */
export function historyToolkitCapabilities({
  verified = false, canEdit = false, uploadedZip = false
} = {}) {
  const hosting = verified
    ? cap('included_verified', 'verified_launch_job',
      'Customer-owned Cloudflare Pages from a verified launch in your history.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Hosting appears after Launch & Own verifies the public site.');
  const https = verified
    ? cap('included_verified', 'verified_https_publication',
      'Public HTTPS was confirmed with the approved revision.')
    : cap('not_available', 'awaiting_public_https_verification',
      'HTTPS status waits on verified publication.');
  const health = verified
    ? cap('included_verified', 'verified_launch_job',
      'Last successful verify for this retained launch record.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Deployment health is shown after a verified live check.');
  let updates;
  if (uploadedZip)
    updates = cap('not_available', 'uploaded_source_has_no_supported_editor',
      'Uploaded ZIP sites keep the GitHub workflow; the one-page editor does not apply.');
  else if (canEdit && verified)
    updates = cap('available_opt_in', 'editor_eligible',
      'Edit → exact preview → approve → merge one GitHub update → we verify live.');
  else
    updates = cap('not_available', 'update_acceptance_pending',
      verified
        ? 'This retained site is not eligible for the one-page editor yet.'
        : 'Website updates unlock after the site is verified live.');
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

const STATUS_COPY = Object.freeze({
  live: {
    label: 'Previously verified',
    detail: 'Launch & Own checked the public website against the approved launch.'
  },
  pending_deployment: {
    label: 'Publishing',
    detail: 'Waiting for verification of the approved launch.'
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

export function websiteUrlForSlug(siteSlug) {
  if (typeof siteSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug))
    return null;
  return 'https://esp-' + siteSlug + '-site.pages.dev/';
}

const UPDATE_STEPS = [
  {id: 'approved', title: 'Update approved', hint: 'Exact preview saved.'},
  {id: 'merge', title: 'Publish in GitHub', hint: 'Open the pull request and click Merge to publish.'},
  {id: 'publishing', title: 'Checking your live site', hint: 'Waiting for the public site to match the approved change.'},
  {id: 'live', title: 'Live', hint: 'Public site matches the approved update.'}
];

export function updatePublicationLadder({prStatus, verifyStatus = null}) {
  if (prStatus === 'closed-unmerged') return {current: 'closed', steps: [], primaryAction: null};
  if (!['awaiting-customer-merge', 'open', 'merged'].includes(prStatus))
    return {current: 'unavailable', steps: [], primaryAction: null};
  const current = prStatus === 'merged' ? (verifyStatus === 'live' ? 'live' : 'publishing') : 'merge';
  const actions = {
    merge: {label: 'Open update to publish', detail: 'Click Merge in GitHub when you are ready.'},
    publishing: {label: 'Check again', detail: 'Publishing usually finishes in a few minutes.'},
    live: {label: 'View live website', detail: 'Your approved update is verified on the public site.'}
  };
  return {
    current,
    steps: UPDATE_STEPS.map(step => ({...step, active: step.id === current})),
    primaryAction: actions[current]
  };
}

function timestamp(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const time = new Date(seconds * 1000);
  return Number.isFinite(time.valueOf()) ? time.toISOString() : null;
}

export function projectToolkitCard(job, {canEdit = false, uploadedZip = false} = {}) {
  if (!job || !isLaunchId(job.id)) return null;
  const status = job.display_status || job.status;
  const time = timestamp(job.updated_at);
  const verified = status === 'live' && typeof job.expected_commit_sha === 'string' &&
    SHA.test(job.expected_commit_sha) && time !== null;
  let copy = Object.hasOwn(STATUS_COPY, status) ? STATUS_COPY[status] : {
    label: 'Status unavailable', detail: 'Open launch history for the latest recorded result.'
  };
  if (status === 'live' && !verified)
    copy = {label: 'Verification details unavailable', detail: 'Open launch history for the recorded result.'};
  const editable = verified && canEdit;
  const zip = Boolean(uploadedZip) || Number(job.uploaded_zip) === 1;
  return {
    name: job.customer_name,
    statusLabel: copy.label,
    statusDetail: copy.detail,
    recordedWebsite: verified ? websiteUrlForSlug(job.site_slug) : null,
    verifiedCommitSha: verified ? job.expected_commit_sha.toLowerCase() : null,
    verifiedAt: verified ? time : null,
    expiresAt: timestamp(job.expires_at),
    approvalFingerprint: typeof job.approval_digest === 'string' && DIGEST.test(job.approval_digest)
      ? job.approval_digest.toLowerCase() : null,
    errorCode: typeof job.error_code === 'string' ? job.error_code : null,
    editPath: editable ? '/site-update?id=' + encodeURIComponent(job.id) : null,
    optionsPath: optionsPathForJob(job.id, status),
    capabilities: historyToolkitCapabilities({
      verified, canEdit: editable, uploadedZip: zip
    })
  };
}

export async function loadToolkitCards(env, session, time) {
  const rows = await listOwnedJobs(env, session, time);
  const cards = rows.map(job => projectToolkitCard(job, {
    canEdit: Number(job.can_edit) === 1,
    uploadedZip: Number(job.uploaded_zip) === 1
  })).filter(Boolean);
  if (!await hasCurrentOwnerSession(env, session, Math.floor(Date.now() / 1000)))
    throw Error('Account authorization changed');
  return cards;
}

export function renderToolkitPage(cards, current, {view, escape}, {currentInventoryHtml = ''} = {}) {
  if (!current?.cloudflare_account_id)
    return view('Your website toolkit',
      '<p>Connect GitHub and choose your Cloudflare account to see your sites.</p>' +
      '<p><a href="/">Back to setup</a></p>');
  const body = cards.length
    ? cards.map(card => renderCard(card, escape)).join('')
    : '<p>No websites in your current launch history yet. Create or upload a site first.</p>';
  return view('Your website toolkit',
    '<p>Launch history is available for 30 days. Verification details reflect the recorded launch.</p>' +
    body + currentInventoryHtml +
    '<p><a href="/history">Launch history</a> · <a href="/">Back to setup</a></p>');
}

function renderCard(card, escape) {
  const time = iso => '<time datetime="' + escape(iso) + '">' + escape(iso.slice(0, 10)) +
    ' ' + escape(iso.slice(11, 16)) + ' UTC</time>';
  const website = card.recordedWebsite
    ? '<p>Website address at verification <code>' + escape(card.recordedWebsite) + '</code></p>' : '';
  const verification = card.verifiedAt
    ? '<p>Last verified at ' + time(card.verifiedAt) + '</p><p>Verified GitHub revision <code>' +
      escape(card.verifiedCommitSha) + '</code></p>' : '';
  const expires = card.expiresAt ? '<p>Available in history until ' + time(card.expiresAt) + '</p>' : '';
  const digest = card.approvalFingerprint
    ? '<p>Approval fingerprint <code>' + escape(card.approvalFingerprint.slice(0, 12)) + '…</code></p>' : '';
  const error = card.errorCode
    ? '<p>Last result code <code>' + escape(card.errorCode) + '</code></p>' : '';
  const edit = card.editPath
    ? '<p><a href="' + escape(card.editPath) + '">Update this website</a></p>' : '';
  const options = card.optionsPath
    ? '<p><a href="' + escape(card.optionsPath) + '">Optional domain, email, and form requests</a></p>' : '';
  const caps = Object.entries(card.capabilities || {}).map(([id, item]) => {
    const label = CAP_LABELS[id] || id;
    return '<li><strong>' + escape(label) + '</strong> (' + escape(item.state) + '): ' +
      escape(item.detail) + '</li>';
  }).join('');
  return '<section><h2>' + escape(card.name) + '</h2><p class="pill">' + escape(card.statusLabel) + '</p>' +
    '<p>' + escape(card.statusDetail) + '</p>' + website + verification + expires + digest + error + edit +
    options +
    '<details><summary>Toolkit capabilities</summary><ul>' + caps + '</ul></details></section>';
}

export function renderUpdateStatusBody({pr, verifyResult, approvedHtmlSha256, ticketRaw, jobId, escape}) {
  const ladder = updatePublicationLadder({
    prStatus: pr.status, verifyStatus: verifyResult?.status
  });
  if (ladder.current === 'closed')
    return '<p role="status">This pull request was closed before merging.</p>' +
      (isLaunchId(jobId) ? '<p><a href="/site-update?id=' + encodeURIComponent(jobId) + '">Start a fresh edit</a></p>' : '');
  if (ladder.current === 'unavailable') return '<p>Update status is unavailable.</p>';

  const steps = ladder.steps.map(step =>
    '<li' + (step.active ? '><strong>' : '>') + escape(step.title) +
    (step.active ? '</strong>' : '') + ' — ' + escape(step.hint) + '</li>'
  ).join('');
  const {label, detail} = ladder.primaryAction;
  const mergeCta = ladder.current === 'merge' && pr.pullRequest
    ? '<p><a class="btn-like" href="' + escape(pr.pullRequest) + '" rel="noopener"><strong>' +
      escape(label) + '</strong></a></p><p>' + escape(detail) + '</p>' : '';
  const live = ladder.current === 'live' && verifyResult.website
    ? '<p class="pill">Verified live</p><p><a href="' + escape(verifyResult.website) + '">' +
      escape(verifyResult.website) + '</a></p>' : '';
  const checking = ladder.current === 'publishing' ? '<p>' + escape(detail) + '</p>' : '';
  const refresh = '<p><a href="/site-update-status?ticket=' + encodeURIComponent(ticketRaw) + '">Refresh status</a></p>';
  const revision = pr.mergedCommitSha ? '<p>Merged GitHub revision <code>' + escape(pr.mergedCommitSha) + '</code></p>' : '';
  return '<ol>' + steps + '</ol>' + mergeCta + live + checking + refresh +
    '<details><summary>Approved update</summary>' + revision + '<p>Exact preview SHA-256 <code>' +
    escape(approvedHtmlSha256) + '</code></p></details>' +
    '<p><a href="/toolkit">Website toolkit</a> · <a href="/history">Launch history</a></p>';
}
