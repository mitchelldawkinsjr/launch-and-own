// Customer-owned assistant edit flow (M2 slice 2, #195). Same steps and library as the hosted flow:
// read the live repo -> locate/validate -> sealed 15-minute ticket -> re-derive and review -> approve -> PR (never merge).
// Nothing is stored between steps except the single-use approval claim; every step re-reads GitHub, so a moved base fails closed.
import { escape } from '../onboarding/ui.mjs';
import { editReviewMarkup } from '../onboarding/edit-review.mjs';
import { base64Decode, base64Encode } from '../imported/bytes.mjs';
import { readCurrentRevision } from '../imported/revision.mjs';
import { inspectSite } from '../imported/intelligence.mjs';
import { locateTypedEdit } from '../imported/locate.mjs';
import { parseModelOutput, validateEdits } from '../imported/edits.mjs';
import { buildModelRequest, retrieveSnippets } from '../imported/snippets.mjs';
import { isolatePreview, previewResponse } from '../imported/preview.mjs';
import { bindApproval, newApprovalId } from '../imported/approval.mjs';
import { proposeImportedPullRequest, readImportedPullRequest } from '../imported/pull-request.mjs';
import { d1ApprovalStore } from '../imported/approval-store.mjs';
import { ImportedEditError } from '../imported/errors.mjs';
import { MergeRefused, mergeVerifiedPullRequest } from '../pipeline/merge-approved-pr.mjs';
import { mintInstallationToken } from './github-app.mjs';
import { DEFAULT_DAILY_NEURONS, reserveNeurons } from './budget.mjs';

const KINDS = new Set(['text', 'link', 'business_info', 'css_color']);
const REVIEW_SECONDS = 15 * 60, STATUS_SECONDS = 7 * 86400;
// shortcut: a fixed per-request reservation, not metered usage. Measured 2026-11-26: about 900 tokens per request,
// which is at most ~60 Neurons on gpt-oss-120b; 150 leaves margin for larger pages.
export const AI_REQUEST_NEURONS = 150;
export const DEFAULT_AI_MODEL = '@cf/openai/gpt-oss-120b';
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
const MESSAGES = {
  stale_base: 'Your website changed since this preview. Start again so the change is based on the latest version.',
  expired: 'This preview expired. Start again.', approval_mismatch: 'This approval does not match the preview. Start again.',
  approval_consumed: 'This approval was already used.', credentials_revoked: 'GitHub access for the assistant was removed or changed. Check the GitHub App installation.',
  quota_exhausted: "Today's AI allowance for the assistant is used up. Try again after midnight UTC, or type the exact change instead.",
  not_found_anywhere: 'That text was not found on any page the assistant can edit. Copy it exactly as it appears.',
  no_match: 'That text was not found in that page.', ambiguous_match: 'That text appears more than once on the page. Use a longer, unique piece of text.',
  context_not_allowed: 'That part of the page cannot be changed this way.', kind_not_allowed: 'That kind of change is not allowed in that file.',
  limit_exceeded: 'That change is too large.', invalid_output: 'The assistant could not turn that request into a safe change. Try typing the exact change.',
  'repository-mismatch': 'The website repository does not match the assistant settings.', compiled_bundle: 'This site is a compiled bundle, which the assistant cannot edit.',
  source_project: 'This repository holds source code rather than a built site, which the assistant cannot edit.', unsupported: 'This site type is not supported.'
};

const b64url = bytes => base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = text => base64Decode(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
async function mac(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.KEK), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('ticket:' + text)))); // 43 chars
}

/** Sealed, owner-bound, expiring ticket. Not encrypted: it carries only what the owner already sees. */
export async function sealTicket(env, kind, sub, data, now, seconds = REVIEW_SECONDS) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ ...data, k: kind, sub, exp: Math.floor(now / 1000) + seconds })));
  return payload + await mac(env, payload);
}
export async function openTicket(env, kind, sub, raw, now) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{50,6000}$/.test(raw)) throw new ImportedEditError('approval_mismatch');
  const payload = raw.slice(0, -43), given = raw.slice(-43), want = await mac(env, payload);
  if ([...given].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) !== 0) throw new ImportedEditError('approval_mismatch');
  let data;
  try { data = JSON.parse(new TextDecoder().decode(fromB64url(payload))); } catch { throw new ImportedEditError('approval_mismatch'); }
  if (data?.k !== kind || data.sub !== sub) throw new ImportedEditError('approval_mismatch');
  if (!Number.isSafeInteger(data.exp) || data.exp <= Math.floor(now / 1000)) throw new ImportedEditError('expired');
  return data;
}

const page = (title, body, status = 200) => new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + escape(title) + '</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem">' +
  '<p><a href="/">Your website assistant</a></p><h1>' + escape(title) + '</h1>' + body + '</body></html>', { status, headers: PAGE_HEADERS });
const redirect = location => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

function failure(error) {
  if (error instanceof ImportedEditError) {
    if (error.code === 'ambiguous_pages') return page('Choose a page', '<p>That text is on more than one page: ' + error.paths.map(p => '<code>' + escape(p) + '</code>').join(', ') + '. Go back and enter the page file to change.</p>', 400);
    return page('Nothing was changed', '<p>' + escape(MESSAGES[error.code] || 'The change could not be prepared safely.') + '</p><p><a href="/">Start again</a></p>', 400);
  }
  return page('Nothing was changed', '<p>Something went wrong, and nothing was changed. Try again later.</p>', 502);
}

export function siteConfig(env) {
  const repositoryId = Number(env.WEBSITE_REPO_ID);
  if (!/^[A-Za-z0-9_.-]+$/.test(env.WEBSITE_OWNER || '') || !/^esp-[a-z0-9-]{1,40}$/.test(env.WEBSITE_REPO || '') || !Number.isSafeInteger(repositoryId) || repositoryId < 1
      || !env.GH_APP_ID || !env.GH_INSTALLATION_ID || !env.GH_APP_PRIVATE_KEY) return null;
  return { owner: env.WEBSITE_OWNER, repo: env.WEBSITE_REPO, repositoryId, appId: env.GH_APP_ID, installationId: env.GH_INSTALLATION_ID, privateKeyPem: env.GH_APP_PRIVATE_KEY };
}

/** Fresh read of the live repo with a one-hour token restricted to the website repo. */
async function liveSite(site, { fetchFn, now }) {
  const { token } = await mintInstallationToken({ ...site, fetchFn, now: () => now });
  const revision = await readCurrentRevision({ owner: site.owner, repo: site.repo, token, fetchFn, installationRepositoryId: site.repositoryId });
  const files = revision.files.map(file => ({ path: file.path, bytes: file.bytes }));
  const inspection = await inspectSite(files);
  if (inspection.classification !== 'static' && inspection.classification !== 'static_multipage') {
    throw new ImportedEditError(inspection.classification === 'compiled_bundle' ? 'compiled_bundle' : inspection.classification === 'unsupported' ? 'unsupported' : 'source_project');
  }
  return { token, revision, files, inspection };
}

/** Re-derive the reviewed tree from the current repo; fails closed with stale_base if main moved. */
async function reviewedTree(site, ticket, deps) {
  const live = await liveSite(site, deps);
  if (live.revision.commitSha !== ticket.baseCommitSha || live.revision.repositoryId !== site.repositoryId) throw new ImportedEditError('stale_base');
  const proposal = parseModelOutput(JSON.stringify({ v: 1, requestId: ticket.requestId, repositoryId: site.repositoryId, baseCommitSha: ticket.baseCommitSha, summary: ticket.summary, edits: ticket.edits }));
  const validated = await validateEdits({ baseCommitSha: ticket.baseCommitSha, files: live.files, inspection: live.inspection, proposal, repositoryId: site.repositoryId });
  if (validated.proposalDigest !== ticket.proposalDigest || validated.artifactDigest !== ticket.artifactDigest) throw new ImportedEditError('approval_mismatch');
  return { ...live, validated };
}

const modelText = out => typeof out?.response === 'string' ? out.response : out?.response && typeof out.response === 'object' ? JSON.stringify(out.response) : out?.choices?.[0]?.message?.content ?? '';
const outermostObject = raw => { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); return a >= 0 && b > a ? raw.slice(a, b + 1) : raw; };

function home(env, csrf) {
  const ai = env.AI_EDITS === 'on' && env.AI;
  return page('Change your website',
    '<p>Every change is previewed first. <strong>Nothing goes live until you approve it</strong>. Approving publishes exactly that change, or you can open a pull request instead and merge it yourself.</p>' +
    '<form method="post" action="/preview"><input type="hidden" name="csrf" value="' + escape(csrf) + '"><input type="hidden" name="mode" value="typed">' +
    '<p><label>What kind of change<br><select name="kind"><option value="text">Text</option><option value="link">Link</option><option value="business_info">Email or phone</option><option value="css_color">Color</option></select></label></p>' +
    '<p><label>Current text, exactly as it appears<br><input name="old" maxlength="500" required size="50"></label></p>' +
    '<p><label>Replace it with<br><input name="replacement" maxlength="500" required size="50"></label></p>' +
    '<details><summary>Same text on more than one page?</summary><p><label>Page file<br><input name="path" maxlength="240" placeholder="contact.html"></label></p></details>' +
    '<p><button>Preview the change</button></p></form>' +
    (ai ? '<h2>Or describe it</h2><form method="post" action="/preview"><input type="hidden" name="csrf" value="' + escape(csrf) + '"><input type="hidden" name="mode" value="ai">' +
      '<p><label>What should change?<br><textarea name="request" maxlength="1000" rows="3" cols="50" required></textarea></label></p>' +
      '<p><small>Uses your own Cloudflare Workers AI allowance. You still see the exact change before anything happens.</small></p><p><button>Prepare a preview</button></p></form>' : ''));
}

async function preview(env, site, form, { sub, fetchFn, now }) {
  const deps = { fetchFn, now };
  const live = await liveSite(site, deps);
  const requestId = crypto.randomUUID();
  let summary = 'Owner change', edits, validated;
  if (form.get('mode') === 'ai') {
    if (env.AI_EDITS !== 'on' || !env.AI) throw new ImportedEditError('kind_not_allowed');
    const request = String(form.get('request') || '').trim();
    if (!request || request.length > 1000) throw new ImportedEditError('invalid_output');
    const limit = Number(env.DAILY_NEURON_BUDGET) || DEFAULT_DAILY_NEURONS;
    // Budget is reserved before the call, never after (threat model #9).
    if (!await reserveNeurons(env.DB, AI_REQUEST_NEURONS, { limit, now: () => now })) throw new ImportedEditError('quota_exhausted');
    const built = buildModelRequest({
      baseCommitSha: live.revision.commitSha, instruction: request, requestId, repositoryId: site.repositoryId,
      snippets: retrieveSnippets(live.files, { query: request, maxSnippets: 8, maxBytes: 8192, window: 2000 }),
      capabilities: { files: live.inspection.files.map(f => ({ path: f.path, blobSha: f.blobSha, editable: f.editable, readOnlyReason: f.readOnlyReason })) }
    });
    const out = await env.AI.run(env.AI_MODEL || DEFAULT_AI_MODEL, { messages: [{ role: 'system', content: built.system }, { role: 'user', content: JSON.stringify(built.user) }], max_tokens: 2500, temperature: 0 });
    const proposal = parseModelOutput(outermostObject(modelText(out)));
    if (!Array.isArray(proposal.edits) || proposal.edits.length === 0) throw new ImportedEditError('invalid_output');
    validated = await validateEdits({ baseCommitSha: live.revision.commitSha, files: live.files, inspection: live.inspection, proposal, repositoryId: site.repositoryId });
    // parseModelOutput returns its internal shape ({path without public/, old, new}); store the contract shape.
    edits = proposal.edits.map(e => ({ kind: e.kind, path: 'public/' + e.path, expectedBlobSha: e.expectedBlobSha, find: e.old, replace: e.new }));
    summary = typeof proposal.summary === 'string' ? proposal.summary.slice(0, 200) : summary;
  } else {
    const kind = String(form.get('kind') || ''), find = String(form.get('old') || ''), replace = String(form.get('replacement') || ''), path = String(form.get('path') || '').trim() || null;
    if (!KINDS.has(kind) || !find || !replace || find.length > 500 || replace.length > 500 || (path && path.length > 240)) throw new ImportedEditError('invalid_output');
    const located = await locateTypedEdit({ files: live.files, inspection: live.inspection, revision: { repositoryId: site.repositoryId, commitSha: live.revision.commitSha }, kind, find, replace, path, requestId, summary });
    edits = located.contractEdits; validated = located.validated;
  }
  const ticket = await sealTicket(env, 'review', sub, {
    repositoryId: site.repositoryId, baseCommitSha: live.revision.commitSha, requestId, summary, edits,
    proposalDigest: validated.proposalDigest, artifactDigest: validated.artifactDigest, approvalId: newApprovalId()
  }, now);
  // The review screen and URLs accept tickets up to 6,000 characters; a larger proposal fails clearly here, not as a mismatch later.
  if (ticket.length > 6000) throw new ImportedEditError('limit_exceeded');
  return redirect('/review?ticket=' + encodeURIComponent(ticket));
}

async function review(env, site, url, { sub, csrf, fetchFn, now }) {
  const raw = url.searchParams.get('ticket');
  const ticket = await openTicket(env, 'review', sub, raw, now);
  const { validated } = await reviewedTree(site, ticket, { fetchFn, now });
  const screen = editReviewMarkup({
    proposal: { v: 1, summary: ticket.summary, edits: ticket.edits },
    binding: { approvalId: ticket.approvalId, proposalDigest: ticket.proposalDigest, artifactDigest: ticket.artifactDigest, baseCommitSha: ticket.baseCommitSha, expiresAt: ticket.exp },
    approve: { action: '/approve', csrf }, ticket: raw, now
  });
  const links = validated.changed.map(c => c.path.slice('public/'.length)).map(p => '<li><a href="/file?ticket=' + encodeURIComponent(raw) + '&amp;path=' + encodeURIComponent(p) + '" target="_blank" rel="noopener noreferrer">' + escape(p) + '</a></li>').join('');
  return page('Review this change', screen + '<h2>Exact changed files</h2><p>Open the proposed file as it would be published. Scripts are blocked.</p><ul>' + links + '</ul>');
}

async function file(env, site, url, { sub, fetchFn, now }) {
  const ticket = await openTicket(env, 'review', sub, url.searchParams.get('ticket'), now);
  const { validated } = await reviewedTree(site, ticket, { fetchFn, now });
  // Fully sandboxed, script-free response from the shared library (same as the hosted "exact changed file" view).
  const out = previewResponse({ credentialsIncluded: false, files: validated.files }, '/' + (url.searchParams.get('path') || ''));
  return new Response(out.body, { status: out.status, headers: out.headers });
}

async function approve(env, site, form, { sub, fetchFn, now }) {
  const ticket = await openTicket(env, 'review', sub, String(form.get('ticket') || ''), now);
  if (form.get('approvalId') !== ticket.approvalId || form.get('proposalDigest') !== ticket.proposalDigest || form.get('artifactDigest') !== ticket.artifactDigest) throw new ImportedEditError('approval_mismatch');
  const { token, revision, files, validated } = await reviewedTree(site, ticket, { fetchFn, now });
  const preview = await isolatePreview({ files: validated.files, baseCommitSha: revision.commitSha, githubUserId: revision.githubUserId, repositoryId: site.repositoryId, ownerLogin: site.owner });
  const receipt = await bindApproval({
    explicitlyApproved: true, preview, changed: validated.changed, githubUserId: revision.githubUserId, repositoryId: site.repositoryId,
    ownerLogin: site.owner, repository: site.owner + '/' + site.repo, baseCommitSha: ticket.baseCommitSha, proposalDigest: validated.proposalDigest,
    approvalId: ticket.approvalId, expiresAt: ticket.exp, owner: { provider: 'cloudflare_access', id: sub }
  });
  const proposal = await proposeImportedPullRequest(receipt, { baseFiles: files, nextFiles: validated.files }, { githubToken: token, fetchFn, approvalStore: d1ApprovalStore(env.DB), installation: true });
  if (proposal.live !== false || proposal.merged !== false) throw new ImportedEditError('pull-request-unreadable');
  // Owner decision 2026-11-26: "Approve and publish" merges this exact PR; "Open a pull request instead" leaves it open.
  let mergeNote = null;
  if (form.get('action') !== 'pr') {
    try {
      const pull = await readImportedPullRequest(receipt, { githubToken: token, fetchFn, number: proposal.number, headCommitSha: proposal.headCommitSha, installation: true });
      if (pull.status !== 'pr_open') throw new MergeRefused('merge_blocked');
      await mergeVerifiedPullRequest({ owner: site.owner, repoName: site.repo, number: proposal.number, headCommitSha: proposal.headCommitSha, baseCommitSha: ticket.baseCommitSha },
        { githubToken: token, fetchFn });
    } catch (error) {
      if (!(error instanceof MergeRefused)) throw error;
      mergeNote = error.code; // the PR stays open for the owner
    }
  }
  const status = await sealTicket(env, 'status', sub, { mergeNote,
    receipt: { ownerLogin: receipt.ownerLogin, repository: receipt.repository, owner: receipt.owner, repositoryId: receipt.repositoryId, baseCommitSha: receipt.baseCommitSha, artifactDigest: receipt.artifactDigest },
    number: proposal.number, headCommitSha: proposal.headCommitSha, summary: ticket.summary, edits: ticket.edits, proposalDigest: ticket.proposalDigest
  }, now, STATUS_SECONDS);
  return redirect('/pr?ticket=' + encodeURIComponent(status));
}

async function prStatus(env, site, url, { sub, fetchFn, now }) {
  const ticket = await openTicket(env, 'status', sub, url.searchParams.get('ticket'), now);
  const { token } = await mintInstallationToken({ ...site, fetchFn, now: () => now });
  const out = await readImportedPullRequest(ticket.receipt, { githubToken: token, fetchFn, number: ticket.number, headCommitSha: ticket.headCommitSha, installation: true });
  const screen = editReviewMarkup({ proposal: { v: 1, summary: ticket.summary, edits: ticket.edits }, binding: { proposalDigest: ticket.proposalDigest, artifactDigest: ticket.receipt.artifactDigest, baseCommitSha: ticket.receipt.baseCommitSha }, status: out.status === 'failed' ? 'failed' : out.status, now });
  const blocked = ticket.mergeNote === 'stale_base' ? 'Your website changed after you approved, so it was not published automatically. '
    : ticket.mergeNote ? 'GitHub did not allow an automatic merge, so it was not published. ' : '';
  const next = out.status === 'merged' ? '<p>Published: merged into your website\'s <code>main</code> branch. Cloudflare Pages is publishing it; check your live site in a minute.</p>'
    : out.status === 'pr_open' ? '<p>' + escape(blocked) + 'The pull request is open for you to review and merge in GitHub.</p>' : '';
  return page('Change status', screen + next + '<p><a href="' + escape(out.pullRequest) + '" target="_blank" rel="noopener noreferrer">Open the pull request</a> (opens in a new tab)</p>');
}

/** Routes after the Worker has verified Access, the owner and (for POST) origin + CSRF. Returns null for unknown routes. */
export async function editRoute(request, url, form, env, ctx) {
  const routes = { 'GET /': 1, 'POST /preview': 1, 'GET /review': 1, 'GET /file': 1, 'POST /approve': 1, 'GET /pr': 1 };
  if (!routes[request.method + ' ' + url.pathname]) return null;
  const site = siteConfig(env);
  if (!site) return page('Assistant not set up', '<p>Finish the GitHub setup (App ID, installation, website repository) first. See <code>/status</code>.</p>', 503);
  if (url.pathname === '/') return home(env, ctx.csrf);
  try {
    if (url.pathname === '/preview') return await preview(env, site, form, ctx);
    if (url.pathname === '/review') return await review(env, site, url, ctx);
    if (url.pathname === '/file') return await file(env, site, url, ctx);
    if (url.pathname === '/approve') return await approve(env, site, form, ctx);
    return await prStatus(env, site, url, ctx);
  } catch (error) {
    return failure(error);
  }
}
