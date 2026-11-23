/**
 * Owner-scoped post-launch toolkit projections (#87).
 * Read-only: uses existing launch-job ownership checks. Does not call
 * providers, invent analytics/metrics, or claim PR previews are enabled.
 */
import {getOwnedJob, listOwnedJobs, isLaunchId} from './launch-jobs.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;

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

/** Honest placeholders until #84/#85/#86 verify provider truth. */
const CAPABILITY_PLACEHOLDERS = Object.freeze({
  hosting: Object.freeze({
    state: 'included_verified',
    label: 'Hosting & HTTPS',
    detail: 'Customer-owned Cloudflare Pages when the site is verified live.'
  }),
  analytics: Object.freeze({
    state: 'manual_setup',
    label: 'Visitor insights',
    detail: 'Not configured here yet. Use Cloudflare Pages → Metrics → Web Analytics when ready (#85).'
  }),
  prPreviews: Object.freeze({
    state: 'not_available',
    label: 'Private update previews',
    detail: 'GitHub PR previews stay off until you opt in; draft URLs can be public (#86).'
  }),
  updates: Object.freeze({
    state: 'available_opt_in',
    label: 'Safe website updates',
    detail: 'Edit → exact preview → approve → merge one GitHub update → we verify live.'
  })
});

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

/**
 * Plain-language ladder for post-approval update status (non-technical).
 * @param {{prStatus: string, verifyStatus?: string|null}} input
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
  if (prStatus === 'awaiting-customer-merge' || prStatus === 'open')
    current = 'merge';
  else if (prStatus === 'closed-unmerged')
    current = 'merge';
  else if (prStatus === 'merged' && verifyStatus === 'live')
    current = 'live';
  else if (prStatus === 'merged')
    current = 'publishing';
  return Object.freeze({
    current,
    steps: Object.freeze(steps.map(step => Object.freeze({
      ...step,
      active: step.id === current
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
    errorCode: typeof job.error_code === 'string' ? job.error_code : null,
    canEdit: Boolean(canEdit) && live,
    editPath: Boolean(canEdit) && live ? '/site-update?id=' + encodeURIComponent(job.id) : null,
    capabilities: CAPABILITY_PLACEHOLDERS
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
  const err = card.errorCode
    ? '<p>Last result code: <code>' + escape(card.errorCode) + '</code></p>'
    : '';
  const edit = card.editPath
    ? '<p><a href="' + escape(card.editPath) + '">Update this website</a></p>'
    : '';
  const caps = Object.values(card.capabilities).map(cap =>
    '<li><strong>' + escape(cap.label) + '</strong> (' + escape(cap.state) + '): ' +
    escape(cap.detail) + '</li>'
  ).join('');
  return '<section><h2>' + escape(card.name) + '</h2>' +
    '<p class="pill">' + escape(card.statusLabel) + '</p>' +
    '<p>' + escape(card.statusDetail) + '</p>' +
    live + repo + commit + digest + err + edit +
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
    ? '<p role="alert">That update was closed without merging. Start a fresh edit if you still want the change.</p>'
    : '';
  return '<ol>' + steps + '</ol>' + mergeCta + closed + liveLink +
    '<p><a href="/site-update-status?ticket=' + encodeURIComponent(ticketRaw) +
    '">Refresh status</a></p>' +
    '<p class="muted">Approved content fingerprint: <code>' +
    escape(String(approvedHtmlSha256 || '').slice(0, 16)) + '…</code></p>' +
    '<p><a href="/toolkit">Website toolkit</a> · <a href="/history">Launch history</a></p>';
}
