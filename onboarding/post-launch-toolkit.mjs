/** Owner-scoped launch history and update status views (#87). */
import {hasCurrentOwnerSession, isLaunchId, listOwnedJobs} from './launch-jobs.mjs';
import {optionsPathForJob} from './post-launch-options.mjs';
import {serviceExplorerCss, serviceExplorerMarkup} from './service-explorer.mjs';
import {TOOLKIT_CAPABILITY_STATES} from '../pipeline/toolkit-capabilities.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const STATES = new Set(TOOLKIT_CAPABILITY_STATES);

const CAP_LABELS = Object.freeze({
  static_hosting: 'Website hosting',
  https: 'Secure website address',
  deployment_health: 'Publish health',
  website_updates: 'Safe website updates',
  web_analytics: 'Visitor insights',
  pr_previews: 'Private update previews',
  custom_domains: 'Your own domain name',
  email_routing: 'Email forwarding',
  seo_bundle: 'Search listing help',
  contact_forms: 'Contact forms',
  advanced_services: 'Advanced hosting extras'
});

// Per-site sections: CSS-only tabs (native radios + :has()); without :has() every section stays visible.
const SECTIONS = [['overview', 'Overview'], ['updates', 'Updates'], ['services', 'Services'], ['settings', 'Settings']];
const toolkitTabsCss = `
.tk-site{background:var(--card,#fff);border:1px solid var(--line);border-radius:16px;padding:clamp(16px,3vw,26px);margin:0 0 22px;min-width:0}
.tk-site>h2{margin:0 0 6px}
.tk-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:14px 0 18px;padding:5px;border:1px solid var(--line);border-radius:14px;min-width:0}
.tk-tab{position:relative;padding:9px 10px;border-radius:10px;text-align:center;font-weight:750;cursor:pointer;min-width:0}
.tk-tab:hover{background:#f0f4fa}
.tk-radio{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.tk-tab:has(.tk-radio:checked){background:var(--blue);color:#fff}
.tk-tab:has(.tk-radio:focus-visible){outline:3px solid var(--blue);outline-offset:3px}
.tk-site:has(.tk-radio:checked) .tk-panel{display:none}
${SECTIONS.map(([id]) => `.tk-site:has(.tk-radio[value="${id}"]:checked) .tk-p-${id}`).join(',')}{display:block}
.tk-panel>h3{margin:0 0 8px;font-size:1.05rem}
@media(max-width:520px){.tk-tabs{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const STATE_LABELS = Object.freeze({
  included_verified: 'Included',
  available_opt_in: 'Available',
  active_verified: 'Active',
  manual_setup: 'Set up yourself',
  blocked_permission_or_plan: 'Not ready yet',
  not_available: 'Not available'
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
      'Your site is hosted on Cloudflare in an account you own.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Hosting shows here after we confirm the public site is live.');
  const https = verified
    ? cap('included_verified', 'verified_https_publication',
      'The public address was confirmed as secure for the version you approved.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Secure-address status shows after the public site is confirmed.');
  const health = verified
    ? cap('included_verified', 'verified_launch_job',
      'Last successful live check for this launch.')
    : cap('not_available', 'awaiting_public_https_verification',
      'Publish health shows after a successful live check.');
  let updates;
  if (uploadedZip && verified)
    updates = cap('available_opt_in', 'imported_edit_ready',
      'Change one unique text, link, business detail, or existing color. Preview it, approve a pull request, and merge it yourself.');
  else if (uploadedZip)
    updates = cap('not_available', 'uploaded_source_has_no_supported_editor',
      'Imported editing appears after this ZIP launch is confirmed live.');
  else if (canEdit && verified)
    updates = cap('available_opt_in', 'editor_eligible',
      'Change the copy, preview the exact page, approve, merge in GitHub, then we check the live site.');
  else
    updates = cap('not_available', 'update_acceptance_pending',
      verified
        ? 'This site is not eligible for the simple editor yet.'
        : 'Updates unlock after the site is confirmed live.');
  return Object.freeze({
    static_hosting: hosting,
    https,
    deployment_health: health,
    website_updates: updates,
    web_analytics: cap('manual_setup', 'review_provider_settings',
      'On for sites launched with visitor insights, which is the default. To see them in Cloudflare, open your Pages project, then Metrics, then Web Analytics.'),
    pr_previews: cap('blocked_permission_or_plan', 'preview_access_and_approval_required',
      'Pages PR previews need verified private access and separate approval. Use the exact Launch & Own review to inspect updates.'),
    custom_domains: cap('manual_setup', 'verified_domain_setup_required',
      'Add your own domain name in your Cloudflare Pages project when you are ready.'),
    email_routing: cap('not_available', 'owned_custom_domain_needed',
      'Needs a domain name and inbox you control.'),
    seo_bundle: cap('not_available', 'separate_reviewed_artifact_needed',
      'Extra search-listing setup is a separate reviewed update.'),
    contact_forms: cap('not_available', 'verified_server_form_integration_needed',
      'Contact forms need a separate approved setup.'),
    advanced_services: cap('not_available', 'separate_usage_and_approval_review_needed',
      'Extra Cloudflare services need a reviewed plan first.')
  });
}

const STATUS_COPY = Object.freeze({
  live: {
    label: 'Live and checked',
    detail: 'We confirmed the public website matches the version you approved.'
  },
  pending_deployment: {
    label: 'Publishing',
    detail: 'Your approved site is going live. We will check it next.'
  },
  queued: {
    label: 'Getting ready',
    detail: 'Next we create your private files on GitHub and publish the site.'
  },
  needs_reauthorization: {
    label: 'Reconnect required',
    detail: 'Sign in again with GitHub and Cloudflare, then continue the launch.'
  },
  failed: {
    label: 'Needs attention',
    detail: 'The last launch step stopped. Reconnect, or share the status code if you need help.'
  }
});

export function websiteUrlForSlug(siteSlug) {
  if (typeof siteSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug))
    return null;
  return 'https://esp-' + siteSlug + '-site.pages.dev/';
}

const UPDATE_STEPS = [
  {id: 'approved', title: 'Update approved', hint: 'We saved the exact page you reviewed.'},
  {id: 'merge', title: 'Publish in GitHub', hint: 'Open the change request and click Merge when you are ready.'},
  {id: 'publishing', title: 'Checking your live site', hint: 'Waiting for the public site to match your approved change.'},
  {id: 'live', title: 'Live', hint: 'The public site matches your approved update.'}
];

export function updatePublicationLadder({prStatus, verifyStatus = null}) {
  if (prStatus === 'closed-unmerged') return {current: 'closed', steps: [], primaryAction: null};
  if (!['awaiting-customer-merge', 'open', 'merged'].includes(prStatus))
    return {current: 'unavailable', steps: [], primaryAction: null};
  const current = prStatus === 'merged' ? (verifyStatus === 'live' ? 'live' : 'publishing') : 'merge';
  const actions = {
    merge: {label: 'Open the change to publish', detail: 'In GitHub, click Merge when you are ready.'},
    publishing: {label: 'Check again', detail: 'Publishing usually finishes in a few minutes.'},
    live: {label: 'View live website', detail: 'Your approved update is live on the public site.'}
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
    label: 'Status unavailable', detail: 'Open your launches for the latest recorded result.'
  };
  if (status === 'live' && !verified)
    copy = {label: 'Check details unavailable', detail: 'Open your launches for the recorded result.'};
  const editable = verified && canEdit;
  const zip = Boolean(uploadedZip) || Number(job.uploaded_zip) === 1;
  return {
    name: job.customer_name,
    slug: job.site_slug,
    statusLabel: copy.label,
    statusDetail: copy.detail,
    recordedWebsite: verified ? websiteUrlForSlug(job.site_slug) : null,
    verifiedCommitSha: verified ? job.expected_commit_sha.toLowerCase() : null,
    verifiedAt: verified ? time : null,
    expiresAt: timestamp(job.expires_at),
    approvalFingerprint: typeof job.approval_digest === 'string' && DIGEST.test(job.approval_digest)
      ? job.approval_digest.toLowerCase() : null,
    errorCode: typeof job.error_code === 'string' ? job.error_code : null,
    editPath: editable ? '/site-update?id=' + encodeURIComponent(job.id)
      : zip && verified ? '/imported-edit?id=' + encodeURIComponent(job.id) : null,
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

export function renderToolkitPage(cards, current, {view, escape}, {currentInventoryHtml = '', siteDetails = new Map()} = {}) {
  if (!current?.cloudflare_account_id)
    return view('Your website toolkit',
      '<p>Connect GitHub and choose your Cloudflare account to see your sites here.</p>' +
      '<p><a href="/">Back to setup</a></p>');
  const body = cards.length
    ? cards.map((card, i) => renderCard(card, escape, i, siteDetails.get(card.slug))).join('')
    : '<p>No websites in your launches yet. Create or upload a site first.</p>';
  return view('Your website toolkit',
    '<style>' + serviceExplorerCss + toolkitTabsCss + '</style><p>Recent launches stay here for 30 days. The details below come from the launch we recorded for you.</p>' +
    body + currentInventoryHtml +
    '<p><a href="/history">Your launches</a> · <a href="/">Back to setup</a></p>');
}

function renderCard(card, escape, index = 0, found = '') {
  const time = iso => '<time datetime="' + escape(iso) + '">' + escape(iso.slice(0, 10)) +
    ' ' + escape(iso.slice(11, 16)) + ' UTC</time>';
  const website = card.recordedWebsite
    ? '<p>Public address when checked: <code>' + escape(card.recordedWebsite) + '</code></p>' : '';
  const verification = card.verifiedAt
    ? '<p>Last checked ' + time(card.verifiedAt) + '</p><p>Checked version: <code>' +
      escape(card.verifiedCommitSha) + '</code></p>' : '';
  const expires = card.expiresAt ? '<p>Stays on this list until ' + time(card.expiresAt) + '</p>' : '';
  const digest = card.approvalFingerprint
    ? '<p>Approval fingerprint <code>' + escape(card.approvalFingerprint.slice(0, 12)) + '…</code></p>' : '';
  const error = card.errorCode
    ? '<p>Last result code <code>' + escape(card.errorCode) + '</code></p>' : '';
  const edit = card.editPath
    ? '<p><a href="' + escape(card.editPath) + '">' +
      (card.editPath.startsWith('/imported-edit') ? 'Edit imported website' : 'Update this website') +
      '</a></p>' : '';
  const options = card.optionsPath
    ? '<p><a href="' + escape(card.optionsPath) + '">Optional domain, email, and form requests</a></p>' : '';
  const caps = Object.entries(card.capabilities || {}).map(([id, item]) => {
    const label = CAP_LABELS[id] || id;
    const state = STATE_LABELS[item.state] || item.state;
    return '<li><strong>' + escape(label) + '</strong> · ' + escape(state) + ': ' +
      escape(item.detail) + '</li>';
  }).join('');
  const updatesCap = card.capabilities?.website_updates;
  const tabs = '<fieldset class="tk-tabs"><legend class="lo-sr">Sections for ' + escape(card.name) + '</legend>' +
    SECTIONS.map(([id, label], i) => '<label class="tk-tab"><input class="tk-radio" type="radio" name="tk-site-' + index +
      '" value="' + id + '" aria-label="' + label + '"' + (i ? '' : ' checked') + '><span aria-hidden="true">' + label + '</span></label>').join('') + '</fieldset>';
  const panel = (id, label, html) => '<div class="tk-panel tk-p-' + id + '"><h3>' + label + '</h3>' + html + '</div>';
  return '<section class="tk-site"><h2>' + escape(card.name) + '</h2><p class="pill">' + escape(card.statusLabel) + '</p>' + tabs +
    panel('overview', 'Overview', '<p>' + escape(card.statusDetail) + '</p>' + website + verification + expires + error +
      (found ? '<h4>In your accounts now</h4>' + found : '')) +
    panel('updates', 'Updates', edit + (updatesCap ? '<p>' + escape(updatesCap.detail) + '</p>' : '') +
      '<p><a href="/history">Your launches</a> shows every recorded launch and its result.</p>') +
    panel('services', 'Services', options +
      '<details><summary>Explore your website services</summary>' + serviceExplorerMarkup({mode:'toolkit', capabilities:card.capabilities}) + '</details>') +
    panel('settings', 'Settings', digest +
      '<details><summary>What this site includes</summary><ul>' + caps + '</ul></details>' +
      '<p>Your files stay in your GitHub account and your hosting in your Cloudflare account. Manage app access in each provider\'s settings.</p>') +
    '</section>';
}

export function renderUpdateStatusBody({pr, verifyResult, approvedHtmlSha256, ticketRaw, jobId, escape}) {
  const ladder = updatePublicationLadder({
    prStatus: pr.status, verifyStatus: verifyResult?.status
  });
  if (pr.status === 'changed-since-review')
    return '<p role="status">The change request version differs from your approval.</p>' +
      (isLaunchId(jobId) ? '<p><a href="/site-update?id=' + encodeURIComponent(jobId) +
        '">Start a fresh edit</a></p>' : '');
  if (ladder.current === 'closed')
    return '<p role="status">That change request was closed before it was published.</p>' +
      (isLaunchId(jobId) ? '<p><a href="/site-update?id=' + encodeURIComponent(jobId) + '">Start a fresh edit</a></p>' : '');
  if (ladder.current === 'unavailable') return '<p>Update status is unavailable right now.</p>';

  const steps = ladder.steps.map(step =>
    '<li' + (step.active ? '><strong>' : '>') + escape(step.title) +
    (step.active ? '</strong>' : '') + ': ' + escape(step.hint) + '</li>'
  ).join('');
  const {label, detail} = ladder.primaryAction;
  const mergeCta = ladder.current === 'merge' && pr.pullRequest
    ? '<p><a class="btn-like" href="' + escape(pr.pullRequest) + '" rel="noopener"><strong>' +
      escape(label) + '</strong></a></p><p>' + escape(detail) + '</p>' : '';
  const live = ladder.current === 'live' && verifyResult.website
    ? '<p class="pill">Live and checked</p><p><a href="' + escape(verifyResult.website) + '">' +
      escape(verifyResult.website) + '</a></p>' : '';
  const checking = ladder.current === 'publishing' ? '<p>' + escape(detail) + '</p>' : '';
  const refresh = '<p><a href="/site-update-status?ticket=' + encodeURIComponent(ticketRaw) + '">Refresh status</a></p>';
  const revision = pr.mergedCommitSha ? '<p>Published version: <code>' + escape(pr.mergedCommitSha) + '</code></p>' : '';
  return '<ol>' + steps + '</ol>' + mergeCta + live + checking + refresh +
    '<details><summary>Technical details</summary>' + revision + '<p>Exact preview code: <code>' +
    escape(approvedHtmlSha256) + '</code></p></details>' +
    '<p><a href="/toolkit">Website toolkit</a> · <a href="/history">Your launches</a></p>';
}
