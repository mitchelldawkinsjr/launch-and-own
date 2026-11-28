/** Owner-scoped launch history and update status views (#87). */
import {hasCurrentOwnerSession, isLaunchId, listOwnedJobs} from './launch-jobs.mjs';
import {optionsPathForJob} from './post-launch-options.mjs';
import {ownerSelfActivationEnabled} from './owner-option-activation.mjs';
import {siteFilesEnabled} from './site-files-flow.mjs';
import {serviceExplorerCss, serviceExplorerMarkup} from './service-explorer.mjs';
import {TOOLKIT_CAPABILITY_STATES} from '../pipeline/toolkit-capabilities.mjs';
import {toolkitAssistantCta} from './assistant-setup.mjs';

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
.tk-site{background:var(--card,#fff);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(15,23,42,.04);padding:clamp(16px,2.5vw,24px);margin:0 0 22px;min-width:0;display:grid;gap:16px}
.tk-site>h2{margin:0 0 6px}
.tk-site-head{padding:0;background:transparent;border:0;box-shadow:none}
.tk-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:0;padding:5px;border:1px solid var(--line);border-radius:14px;background:var(--surface-low,#F8FAFC);min-width:0;box-shadow:none}
.tk-tab{position:relative;padding:9px 10px;border-radius:10px;text-align:center;font-weight:750;cursor:pointer;min-width:0}
.tk-tab:hover{background:#f0f4fa}
.tk-radio{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.tk-tab:has(.tk-radio:checked){background:var(--blue);color:#fff}
.tk-tab:has(.tk-radio:focus-visible){outline:3px solid var(--blue);outline-offset:3px}
.tk-site:has(.tk-radio:checked) .tk-panel{display:none}
${SECTIONS.map(([id]) => `.tk-site:has(.tk-radio[value="${id}"]:checked) .tk-p-${id}`).join(',')}{display:block}
.tk-panel{padding:0;border:0;margin:0;display:grid;gap:16px}
.tk-panel>h3{margin:0 0 8px;font-size:1.05rem}
.tk-block{padding:0;border:0;background:transparent;box-shadow:none;display:grid;gap:12px}
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
 * Optional-feature states follow the same OPTION_* owner Turn on flags as /site-options.
 */
export function historyToolkitCapabilities({
  verified = false, canEdit = false, uploadedZip = false, env = null
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
      'Open the visual editor, preview the exact page, and approve to publish, or open a pull request instead and merge it yourself.');
  else if (uploadedZip)
    updates = cap('not_available', 'uploaded_source_has_no_supported_editor',
      'Imported editing appears after this ZIP launch is confirmed live.');
  else if (canEdit && verified)
    updates = cap('available_opt_in', 'editor_eligible',
      'Change the copy, preview the exact page, and approve to publish (or open a pull request instead). Then we check the live site.');
  else
    updates = cap('not_available', 'update_acceptance_pending',
      verified
        ? 'This site is not eligible for the simple editor yet.'
        : 'Updates unlock after the site is confirmed live.');
  const domainOn = verified && ownerSelfActivationEnabled(env, 'domain');
  const emailOn = verified && ownerSelfActivationEnabled(env, 'email');
  const formsOn = verified && ownerSelfActivationEnabled(env, 'forms');
  const analyticsOn = verified && ownerSelfActivationEnabled(env, 'analytics');
  const filesOn = verified && !!env && siteFilesEnabled(env);
  return Object.freeze({
    static_hosting: hosting,
    https,
    deployment_health: health,
    website_updates: updates,
    web_analytics: analyticsOn
      ? cap('available_opt_in', 'owner_analytics_activation_ready',
        'On by default for new launches. Open Optional features to turn them on if this site needs them, or open Metrics in your Cloudflare Pages project to view them.')
      : cap('manual_setup', 'review_provider_settings',
        'On for sites launched with visitor insights, which is the default. To see them in Cloudflare, open your Pages project, then Metrics, then Web Analytics.'),
    pr_previews: cap('blocked_permission_or_plan', 'preview_access_and_approval_required',
      'Pages PR previews need verified private access and separate approval. Use the exact Launch & Own review to inspect updates.'),
    custom_domains: domainOn
      ? cap('available_opt_in', 'owner_domain_activation_ready',
        'Open Optional features to enter, review and connect your custom domain.')
      : cap('manual_setup', 'verified_domain_setup_required',
        'Add your own domain name in your Cloudflare Pages project when you are ready.'),
    email_routing: emailOn
      ? cap('available_opt_in', 'owner_email_activation_ready',
        'After your custom domain is active, open Optional features to review and turn on email forwarding.')
      : cap('not_available', 'owned_custom_domain_needed',
        'Needs a domain name and inbox you control.'),
    seo_bundle: filesOn
      ? cap('available_opt_in', 'owner_seo_files_ready',
        'Open Optional features and choose Turn on SEO starter to review any missing search engine files.')
      : cap('not_available', 'separate_reviewed_artifact_needed',
        'Extra search-listing setup is a separate reviewed update.'),
    contact_forms: formsOn
      ? cap('available_opt_in', 'owner_forms_activation_ready',
        'Open Optional features to review and set up your contact form.')
      : cap('not_available', 'verified_server_form_integration_needed',
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
  {id: 'merge', title: 'Publish in GitHub', hint: 'This change is waiting as a pull request. Open it and click Merge when you are ready.'},
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

export function projectToolkitCard(job, {canEdit = false, uploadedZip = false, env = null} = {}) {
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
    jobId: job.id,
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
      verified, canEdit: editable, uploadedZip: zip, env
    })
  };
}

export async function loadToolkitCards(env, session, time) {
  const rows = await listOwnedJobs(env, session, time);
  const cards = rows.map(job => {
    const card = projectToolkitCard(job, {
      canEdit: Number(job.can_edit) === 1,
      uploadedZip: Number(job.uploaded_zip) === 1,
      env
    });
    return card ? Object.assign(card, { _env: env }) : null;
  }).filter(Boolean);
  if (!await hasCurrentOwnerSession(env, session, Math.floor(Date.now() / 1000)))
    throw Error('Account authorization changed');
  return cards;
}

const TOOLKIT_INTRO = 'Combines <strong>recorded launch results</strong> (about 30 days) with live account links when Pages access works. Update the site, or open <strong>Optional features</strong> to save a request and turn it on later.';

const STITCH_PAGE = {wide: true, omitTitle: true};

export function renderToolkitPage(cards, current, {view, escape}, {currentInventoryHtml = '', siteDetails = new Map()} = {}) {
  if (!current?.cloudflare_account_id)
    return view('Your website toolkit',
      '<p>Connect GitHub and choose your Cloudflare account to open toolkit and launch history.</p>' +
      '<p class="muted">Until then, finish setup on the home page—nothing here configures domain, email, or forms.</p>' +
      '<p><a href="/">Back to setup</a></p>');
  const liveCount = cards.filter(c => c.recordedWebsite).length;
  const body = '<style>' + serviceExplorerCss + toolkitTabsCss + '</style>' +
    '<div class="lo-page">' +
    '<header class="lo-hero">' +
    '<p class="eyebrow"><span class="lo-badge lo-badge-lo">Direct provider ownership</span>' +
    '<span class="lo-badge lo-badge-gh">GitHub</span><span class="lo-badge lo-badge-cf">Cloudflare</span></p>' +
    '<h1>Your website toolkit</h1>' +
    '<p>' + TOOLKIT_INTRO + '</p></header>' +
    '<div class="lo-stat-grid" role="group" aria-label="Toolkit summary">' +
    '<div class="lo-stat"><span>Provisioned sites</span><strong>' + cards.length + '</strong>' +
    '<p>Recent launches on this list</p></div>' +
    '<div class="lo-stat"><span>Public web</span><strong>' + (liveCount ? 'Live' : '—') + '</strong>' +
    '<p>' + liveCount + ' address' + (liveCount === 1 ? '' : 'es') + ' recorded as live</p></div>' +
    '<div class="lo-stat"><span>Ownership</span><strong>Yours</strong>' +
    '<p>No stored passwords · files stay in your accounts</p></div></div>' +
    '<section class="lo-panel" aria-labelledby="tk-recent-title"><h2 id="tk-recent-title">Recent launches</h2>' +
    '<p class="muted">Rows stay for 30 days after your first approval. Status, address, and fingerprints come from ' +
    'what we recorded when the launch was checked—not a live provider poll. When the site is still in your accounts, ' +
    'live links appear under <strong>In your accounts now</strong> on that card.</p>' +
    (cards.length
      ? cards.map((card, i) => renderCard(card, escape, i, siteDetails.get(card.slug))).join('')
      : '<p>No websites in your recent launches. Create or upload a site from setup, then return after approval.</p>') +
    '</section>' +
    (currentInventoryHtml
      ? '<section class="lo-panel" aria-labelledby="tk-discovered-title"><h2 id="tk-discovered-title">Discovered sites in your accounts</h2>' +
        currentInventoryHtml + '</section>'
      : '') +
    '<p><a href="/history">Your launches</a> · <a href="/">Back to setup</a></p></div>';
  return view('Your website toolkit', body, 200, null, STITCH_PAGE);
}

function renderCard(card, escape, index = 0, found = '') {
  const time = iso => '<time datetime="' + escape(iso) + '">' + escape(iso.slice(0, 10)) +
    ' ' + escape(iso.slice(11, 16)) + ' UTC</time>';
  const website = card.recordedWebsite
    ? '<div class="lo-url"><p>Public address when checked: <code>' + escape(card.recordedWebsite) +
      '</code></p></div>' : '';
  const verification = card.verifiedAt
    ? '<p>Last checked ' + time(card.verifiedAt) + '</p>' +
      '<details><summary>Checked version</summary><p><code>' +
      escape(card.verifiedCommitSha) + '</code></p></details>' : '';
  const expires = card.expiresAt ? '<p>Stays on this list until ' + time(card.expiresAt) + '</p>' : '';
  const digest = card.approvalFingerprint
    ? '<p>Approval fingerprint <code>' + escape(card.approvalFingerprint.slice(0, 12)) + '…</code></p>' : '';
  const error = card.errorCode
    ? '<p>Last result code <code>' + escape(card.errorCode) + '</code></p>' : '';
  const edit = card.editPath
    ? '<a class="btn" href="' + escape(card.editPath) + '">' +
      (card.editPath.startsWith('/imported-edit') ? 'Edit imported website' : 'Update this website') +
      '</a>' : '';
  const options = card.optionsPath
    ? '<p class="tk-actions"><a class="btn-secondary btn" href="' + escape(card.optionsPath) +
      '">Review optional requests (store only)</a></p>' +
      '<p class="muted">Save a request here for review. Nothing is applied from this page.</p>' : '';
  const caps = Object.entries(card.capabilities || {}).map(([id, item]) => {
    const label = CAP_LABELS[id] || id;
    const state = STATE_LABELS[item.state] || item.state;
    return '<li><strong>' + escape(label) + '</strong> · ' + escape(state) + ': ' +
      escape(item.detail) + '</li>';
  }).join('');
  const checkItems = Object.entries(card.capabilities || {})
    .filter(([id]) => ['web_analytics', 'pr_previews', 'custom_domains', 'contact_forms'].includes(id));
  const readyCount = checkItems.filter(([, item]) =>
    ['available_opt_in', 'active_verified', 'included_verified'].includes(item.state)).length;
  const checklist = checkItems.map(([id, item]) => {
    const label = CAP_LABELS[id] || id;
    const state = STATE_LABELS[item.state] || item.state;
    const impact = id === 'pr_previews'
      ? 'Does not change the main public site'
      : id === 'web_analytics'
        ? 'Changes public site on next deploy'
        : 'Changes public site when turned on';
    return '<div class="lo-check"><div><strong>' + escape(label) + '</strong>' +
      '<p>' + escape(impact) + '. ' + escape(item.detail) + '</p></div>' +
      '<span class="lo-badge">' + escape(state) + '</span></div>';
  }).join('');
  const updatesCap = card.capabilities?.website_updates;
  const tabs = '<fieldset class="tk-tabs"><legend class="lo-sr">Sections for ' + escape(card.name) + '</legend>' +
    SECTIONS.map(([id, label], i) => '<label class="tk-tab"><input class="tk-radio" type="radio" name="tk-site-' + index +
      '" value="' + id + '" aria-label="' + label + '"' + (i ? '' : ' checked') + '><span aria-hidden="true">' + label + '</span></label>').join('') + '</fieldset>';
  const panel = (id, label, html) => '<div class="tk-panel tk-p-' + id + '"><h3>' + label + '</h3>' + html + '</div>';
  const dual = '<div class="tk-block"><h3>Public web and verification</h3><div class="lo-dual">' +
    '<div><h3>Your site on the internet <span class="lo-badge lo-badge-live">Public web</span></h3>' +
    '<p class="pill">' + escape(card.statusLabel) + '</p>' +
    '<p>' + escape(card.statusDetail) + '</p>' + website + '</div>' +
    '<div><h3>Launch &amp; Own check <span class="lo-badge lo-badge-lo">Verification</span></h3>' +
    verification + expires + error +
    (card.verifiedAt
      ? '<div class="lo-callout lo-callout-ok">Recorded check matched the approved files.</div>'
      : '<div class="lo-callout lo-callout-warn">Open your launches for the recorded result if a check is missing.</div>') +
    '</div></div></div>';
  const infra = '<div class="tk-block"><h3 class="lo-section-title">Where your site lives</h3>' +
    '<div class="lo-infra" role="group" aria-label="Where this site lives">' +
    '<div><div class="lo-head"><span class="lo-ico lo-ico-gh" aria-hidden="true">GH</span>' +
    '<div><span class="lo-badge lo-badge-gh">GitHub</span><h3>Private repository</h3></div></div>' +
    '<p>Files stay in your GitHub account. Edits publish through a pull request you control.</p>' +
    '<div class="lo-kv"><div><span class="k">Branch</span><span>main</span></div>' +
    '<div><span class="k">Access</span><span>Private</span></div></div></div>' +
    '<div><div class="lo-head"><span class="lo-ico lo-ico-cf" aria-hidden="true">CF</span>' +
    '<div><span class="lo-badge lo-badge-cf">Cloudflare</span><h3>Pages project</h3></div></div>' +
    '<p>Hosting stays in your Cloudflare account. Rebuilds follow merges to <code>main</code>.</p>' +
    '<div class="lo-kv"><div><span class="k">Production branch</span><span>main</span></div>' +
    '<div><span class="k">Ownership</span><span>Your account</span></div></div></div></div>' +
    (found ? '<div class="lo-found"><h4>In your accounts now</h4>' + found + '</div>' : '') +
    '</div>';
  const updateSteps = '<div class="lo-steps" aria-label="How to update this site">' +
    [['1', 'Edit files', 'Change copy here or in your repository.'],
      ['2', 'Open a pull request', 'Preview the exact change before anything goes live.'],
      ['3', 'Merge to main', 'You publish; Launch &amp; Own does not merge without your approval.'],
      ['4', 'Wait for rebuild', 'Cloudflare Pages rebuilds the public site after merge.']
    ].map(([n, t, d]) => '<div class="lo-step-card"><span class="n" aria-hidden="true">' + n +
      '</span><h3>' + t + '</h3><p>' + d + '</p></div>').join('') + '</div>';
  const assistantCta = toolkitAssistantCta({
    jobId: card.jobId, verified: Boolean(card.verifiedAt), env: card._env, escape
  });
  const headActions = edit ? '<p class="tk-actions">' + edit + '</p>' : '';
  return '<section class="tk-site"><div class="tk-site-head"><div><h2>' + escape(card.name) +
    ' — Site toolkit</h2><p class="pill">' + escape(card.statusLabel) + '</p></div>' + headActions + '</div>' + tabs +
    panel('overview', 'Overview', dual + infra + assistantCta) +
    panel('updates', 'Updates',
      '<div class="tk-block"><h4>How to update this site</h4>' +
      updateSteps + (edit ? '<p class="tk-actions" style="margin-top:14px">' + edit + '</p>' : '') +
      (updatesCap ? '<p>' + escape(updatesCap.detail) + '</p>' : '') +
      assistantCta +
      '<p><a href="/history">Your launches</a> shows every recorded launch and its result.</p></div>') +
    panel('services', 'Services',
      '<div class="tk-block">' + options + '</div>' +
      (checklist
        ? '<div class="lo-checklist"><div class="lo-checklist-head"><h2>After launch checklist</h2>' +
          '<span class="lo-badge">' + readyCount + ' of ' + checkItems.length + ' available</span></div>' +
          checklist + '</div>'
        : '') +
      '<div class="tk-block"><details><summary>Explore your website services</summary>' +
      serviceExplorerMarkup({mode:'toolkit', capabilities:card.capabilities}) + '</details></div>') +
    panel('settings', 'Settings',
      '<div class="tk-block">' + digest +
      '<details><summary>What this site includes</summary><ul>' + caps + '</ul></details>' +
      '<p>Your files stay in your GitHub account and your hosting in your Cloudflare account. Manage app access in each provider\'s settings.</p></div>') +
    '</section>';
}

export function renderUpdateStatusBody({pr, verifyResult, approvedHtmlSha256, ticketRaw, jobId, escape, liveWebsite = null, prNumber = null}) {
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

  const order = ['approved', 'merge', 'publishing', 'live'];
  const activeIdx = order.indexOf(ladder.current);
  const statusLine = {
    merge: 'Pipeline status: pull request awaiting your merge',
    publishing: 'Pipeline status: checking your live site',
    live: 'Pipeline status: live and checked'
  }[ladder.current] || 'Pipeline status';
  const pipe = ladder.steps.map((step, i) => {
    const state = step.active ? 'is-active' : (activeIdx > i ? 'is-done' : '');
    const mark = activeIdx > i ? '✓' : String(i + 1);
    const tag = activeIdx > i
      ? '<span class="lo-pipe-tag">Done</span>'
      : (step.active ? '<span class="lo-pipe-tag lo-pipe-tag-now">Now</span>' : '');
    return '<li class="' + state + '"><div class="lo-pipe-top"><span class="n" aria-hidden="true">' +
      mark + '</span>' + tag + '</div><strong>' + escape(step.title) + '</strong><p>' +
      escape(step.hint) + '</p></li>';
  }).join('');
  // Keep vertical ladder for title matches used by status tests/readers.
  const steps = ladder.steps.map((step, i) => {
    const state = step.active ? 'is-active' : (activeIdx > i ? 'is-done' : '');
    const mark = activeIdx > i ? '✓' : String(i + 1);
    return '<li class="' + state + '"><span class="dot" aria-hidden="true">' + mark +
      '</span><div><strong>' + escape(step.title) + '</strong><p>' + escape(step.hint) + '</p></div></li>';
  }).join('');
  const {label, detail} = ladder.primaryAction;
  const mergeCta = ladder.current === 'merge' && pr.pullRequest
    ? '<p class="tk-actions"><a class="btn" href="' + escape(pr.pullRequest) + '" rel="noopener">' +
      escape(label) + '</a></p><p>' + escape(detail) + '</p>' +
      '<div class="lo-callout lo-callout-warn">You click merge in GitHub. Launch &amp; Own cannot merge without your authority.</div>'
    : '';
  const liveUrl = (ladder.current === 'live' && verifyResult?.website) || liveWebsite;
  const live = ladder.current === 'live' && verifyResult?.website
    ? '<p class="pill">Live and checked</p><p><a href="' + escape(verifyResult.website) + '">' +
      escape(verifyResult.website) + '</a></p>' : '';
  const liveProd = liveUrl
    ? '<p class="tk-actions"><a class="btn-secondary btn" href="' + escape(liveUrl) + '">Live production site</a></p>'
    : '';
  const checking = ladder.current === 'publishing' ? '<p>' + escape(detail) + '</p>' : '';
  const refresh = '<p><a href="/site-update-status?ticket=' + encodeURIComponent(ticketRaw) + '">Refresh status</a></p>';
  const revision = pr.mergedCommitSha ? '<p>Published version: <code>' + escape(pr.mergedCommitSha) + '</code></p>' : '';
  const resolvedPrNumber = Number.isSafeInteger(prNumber) && prNumber > 0
    ? prNumber
    : Number((pr.pullRequest || '').match(/\/pull\/(\d+)/)?.[1]);
  const prBadge = Number.isSafeInteger(resolvedPrNumber) && resolvedPrNumber > 0
    ? '<span class="lo-badge lo-badge-lo">Pull request #' + escape(String(resolvedPrNumber)) + '</span>'
    : '<span class="lo-badge lo-badge-lo">Publishing pipeline</span>';
  return '<div class="lo-panel lo-pipe-card">' +
    '<div class="lo-pipe-head"><p class="lo-pipe-status"><strong>' + escape(statusLine) +
    '</strong></p><span class="muted">Direct edge sync after merge</span></div>' +
    '<ol class="lo-pipe" aria-label="Publication steps">' + pipe + '</ol></div>' +
    '<div class="lo-split"><div class="lo-pr-card">' +
    '<p class="eyebrow">' + prBadge +
    '<span class="lo-badge lo-badge-gh">GitHub</span><span class="lo-badge lo-badge-cf">Cloudflare</span></p>' +
    '<h2>Your approved update</h2>' +
    '<p>Updates publish through a pull request you control. Nothing goes live until you merge.</p>' +
    '<ol class="upd-ladder lo-sr" aria-hidden="true">' + steps + '</ol>' +
    mergeCta + live + liveProd + checking + refresh +
    '<details><summary>Technical details</summary>' + revision + '<p>Exact preview code: <code>' +
    escape(approvedHtmlSha256) + '</code></p></details></div>' +
    '<div class="lo-panel lo-own-card"><h2>Ownership stays with you</h2>' +
    '<div class="lo-kv"><div><span class="k">Files</span><span>Your GitHub repository</span></div>' +
    '<div><span class="k">Hosting</span><span>Your Cloudflare Pages project</span></div>' +
    '<div><span class="k">Publish</span><span>Merge or Approve and publish</span></div></div>' +
    '<p class="muted">Launch &amp; Own never holds a durable credential that can merge without your approval.</p>' +
    '<p><a href="/toolkit">Website toolkit</a> · <a href="/history">Your launches</a></p></div></div>' +
    '<div class="lo-panel lo-howto"><h2>How to make future updates</h2>' +
    '<p class="muted">Edit, preview the exact page, then publish through a pull request you control.</p>' +
    '<div class="lo-steps">' +
    [['1', 'Edit', 'Change copy in the editor or in GitHub.'],
      ['2', 'Preview', 'Review the exact page before anything goes live.'],
      ['3', 'Approve', 'Open a pull request or publish with your approval.'],
      ['4', 'Live check', 'We confirm the public site matches what you approved.']
    ].map(([n, t, d]) => '<div class="lo-step-card"><span class="n">' + n + '</span><h3>' + t +
      '</h3><p>' + d + '</p></div>').join('') +
    '</div></div>';
}
