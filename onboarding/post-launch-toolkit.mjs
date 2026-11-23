/** Owner-scoped launch history and update status views (#87). */
import {hasCurrentOwnerSession, isLaunchId, listOwnedJobs} from './launch-jobs.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;

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

export function projectToolkitCard(job, {canEdit = false} = {}) {
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
    editPath: editable ? '/site-update?id=' + encodeURIComponent(job.id) : null
  };
}

export async function loadToolkitCards(env, session, time) {
  const rows = await listOwnedJobs(env, session, time);
  const cards = rows.map(job => projectToolkitCard(job, {canEdit: Number(job.can_edit) === 1})).filter(Boolean);
  if (!await hasCurrentOwnerSession(env, session, Math.floor(Date.now() / 1000)))
    throw Error('Account authorization changed');
  return cards;
}

export function renderToolkitPage(cards, current, {view, escape}) {
  if (!current?.cloudflare_account_id)
    return view('Your website toolkit',
      '<p>Connect GitHub and choose your Cloudflare account to see your sites.</p>' +
      '<p><a href="/">Back to setup</a></p>');
  const body = cards.length
    ? cards.map(card => renderCard(card, escape)).join('')
    : '<p>No websites in your current launch history yet. Create or upload a site first.</p>';
  return view('Your website toolkit',
    '<p>Launch history is available for 30 days. Verification details reflect the recorded launch.</p>' +
    body + '<p><a href="/history">Launch history</a> · <a href="/">Back to setup</a></p>');
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
  return '<section><h2>' + escape(card.name) + '</h2><p class="pill">' + escape(card.statusLabel) + '</p>' +
    '<p>' + escape(card.statusDetail) + '</p>' + website + verification + expires + digest + error + edit +
    '<details><summary>Toolkit capabilities</summary><ul>' +
    '<li>Website editor · ' + (card.editPath ? 'Available for this launch' : 'Unavailable for this launch') + '</li>' +
    '<li>Visitor insights · Setup and traffic verification pending</li>' +
    '<li>GitHub pull request previews · Protected preview setup pending</li>' +
    '</ul></details></section>';
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
