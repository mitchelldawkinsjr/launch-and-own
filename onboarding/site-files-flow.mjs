// Owner turn-on for SEO and redirects (owner decision 2026-11-26): review the exact new files, then
// "Approve and publish" (or open a PR instead). Only adds files; never edits an existing page.
import { readOwnedStoredOptionApproval } from './stored-option-approvals.mjs';
import { getOwnedJob } from './launch-jobs.mjs';
import { seal, unseal } from './crypto.mjs';
import { buildSiteFilesProposal } from '../pipeline/site-files-proposal.mjs';
import { publishSiteFiles, readSiteFiles, SiteFilesRefused } from '../pipeline/publish-site-files.mjs';
import { PreviewBuildPolicyUnavailable, ownerFencedFetch, previewBuildFencedFetch } from './site-update-flow.mjs';

const KINDS = new Set(['seo', 'redirects']);
const LABEL = {seo: 'search engine files', redirects: 'redirects'};
const SHA = /^[a-f0-9]{40}$/i;
const REVIEW_SECONDS = 15 * 60;
const REASON = {
  file_exists: 'The requested path is already in use in your site’s repository.',
  already_present: 'Your site now has both search engine files.',
  no_pages: 'No HTML pages were found in your site’s public folder.',
  too_many_pages: 'Your site has more than 1,000 pages. Add a sitemap in your repository.',
  www_redirect_unsupported: 'www/apex redirects need DNS changes and stay manual.',
  unsafe_rule: 'Enter two different paths on this site, such as /old and /new.',
  no_rules: 'Enter a redirect rule in Optional features.',
  approval_digest_mismatch: 'Your site changed since you reviewed the files. Review them again.',
  repository_mismatch: 'The GitHub repository no longer matches this site.',
  credentials_revoked: 'GitHub access changed. Reconnect and try again.'
};

export function siteFilesEnabled(env) {
  return env.OPTION_OWNER_ACTIVATION_ENABLED === 'true' && env.OPTION_SITE_FILES_ENABLED === 'true';
}

export function createSiteFilesRoutes({view, fail, escape, formData, assertCsrf, baseUrl, assertHistoryAccess, limitAttempts, now}) {
  async function context(env, current, {approvalId, jobId, redirectRule}) {
    if (!siteFilesEnabled(env) || !current?.cloudflare_account_id || Boolean(approvalId) === Boolean(jobId)) return null;
    const reviewed = approvalId ? await readOwnedStoredOptionApproval(env, current, approvalId) : null;
    if (approvalId && !KINDS.has(reviewed?.kind)) return null;
    const job = await getOwnedJob(env, current, reviewed?.jobId ?? jobId, now());
    if (!job || job.status !== 'live' || job.production_branch !== 'main' ||
        !Number.isSafeInteger(job.repository_id) || job.repository_id < 1 || !job.pages_project_id ||
        !SHA.test(job.expected_commit_sha || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.site_slug || '') ||
        job.github_login?.toLowerCase() !== current.github_login?.toLowerCase() ||
        (reviewed && job.repository_id !== reviewed.currentSite.repositoryId)) return null;
    const kind = reviewed?.kind ?? (redirectRule ? 'redirects' : 'seo');
    const repoName = 'esp-' + job.site_slug;
    // Canonical origin: the custom domain this owner turned on for this site, else the site's own pages.dev address.
    const domain = await env.DB.prepare("SELECT payload_json FROM onboarding_option_executions WHERE job_id = ? AND " +
      "github_user_id = ? AND kind = 'domain' AND status = 'applied' ORDER BY updated_at DESC LIMIT 1")
      .bind(job.id, current.github_user_id).first();
    let host = repoName + '-site.pages.dev';
    try { const h = JSON.parse(domain?.payload_json || 'null')?.hostname; if (/^[a-z0-9.-]+$/.test(h || '')) host = h; } catch {}
    const payload = redirectRule ? {wwwMode: 'none', pathRules: [redirectRule]} : reviewed?.normalizedPayload;
    const target = {owner: job.github_login, repoName, repositoryId: job.repository_id,
      propose: paths => buildSiteFilesProposal({kind, payload, paths, origin: 'https://' + host})};
    return {kind, job, target, redirectRule};
  }
  const backToOptions = job => '<p><a class="btn btn-secondary" href="/site-options?id=' + encodeURIComponent(job.id) + '">Back to site options</a></p>';
  const refusedPage = (ctx, code) => view('Could not add ' + LABEL[ctx.kind],
    '<p>' + escape(REASON[code] || 'Reopen your site options and try again.') + '</p>' + backToOptions(ctx.job), 409);
  const ticketContext = (current, redirects) => 'site-files-' + (redirects ? 'redirects' : 'seo') + '-review:' + current.hash;

  async function review(env, current, params) {
    if (params.getAll('id').length + params.getAll('approvalId').length !== 1)
      return fail('Open this option from your site options.', 404);
    const approvalId = params.get('approvalId');
    const ctx = await context(env, current, {approvalId, jobId: params.get('id')});
    if (!ctx) return fail('Open this option from your site options.', 404);
    return reviewFiles(env, current, ctx, approvalId);
  }

  async function reviewRedirects(request, env, current) {
    await limitAttempts(request, env);
    const form = await formData(request);
    assertCsrf(request, form, current, baseUrl(env));
    const redirectRule = {from: form.get('pathFrom'), to: form.get('pathTo')};
    if (form.getAll('id').length !== 1 || form.getAll('pathFrom').length !== 1 || form.getAll('pathTo').length !== 1 ||
        Object.values(redirectRule).some(path => typeof path !== 'string' || !path || path.length > 201))
      return fail('Enter the old and new paths for your redirect.', 400);
    const ctx = await context(env, current, {jobId: form.get('id'), redirectRule});
    if (!ctx) return fail('Open this option from your site options.', 404);
    return reviewFiles(env, current, ctx);
  }

  async function reviewFiles(env, current, ctx, approvalId) {
    const grants = await assertHistoryAccess(env, current);
    let baseSha, proposal;
    try { ({baseSha, proposal} = await readSiteFiles(ctx.target, {githubToken: grants.githubAccessToken, fetchFn: ownerFencedFetch(env, current, now)})); }
    catch (error) { if (error instanceof SiteFilesRefused) return refusedPage(ctx, error.code); throw error; }
    const existing = proposal.existingFiles?.length
      ? '<p>Your site already has ' + proposal.existingFiles.map(path => '<code>' + escape(path) + '</code>').join(' and ') + '.</p>' : '';
    if (proposal.reason === 'already_present')
      return view('Search engine files already exist', existing + backToOptions(ctx.job));
    if (!proposal.ok) return refusedPage(ctx, proposal.reason);
    const reviewField = approvalId
      ? '<input type="hidden" name="approvalId" value="' + escape(approvalId) + '">'
      : '<input type="hidden" name="' + (ctx.redirectRule ? 'redirectTicket' : 'seoTicket') + '" value="' + await seal(env.TOKEN_ENCRYPTION_KEY, JSON.stringify({
        jobId: ctx.job.id, repositoryId: ctx.job.repository_id, baseSha, digest: proposal.digest,
        redirectRule: ctx.redirectRule,
        epoch: current.authorization_epoch, expiresAt: now() + REVIEW_SECONDS
      }), ticketContext(current, ctx.redirectRule)) + '">';
    return view('Review ' + LABEL[ctx.kind],
      existing + '<p>Review the new files before adding them to your website.</p>' +
      proposal.files.map(f => '<h2><code>' + escape(f.path) + '</code></h2><pre>' + escape(f.content) + '</pre>').join('') +
      '<p><strong>Approve and publish</strong> opens a pull request for these files and merges it into <code>main</code> ' +
      'after confirming automatic Cloudflare Pages preview builds are off. To review it in GitHub first, choose ' +
      '<strong>Open a pull request instead</strong>.</p>' +
      '<form class="lo-decision" action="/site-options-files-publish" method="POST"><input type="hidden" name="csrf" value="' + escape(current.csrf) + '">' +
      reviewField +
      '<input type="hidden" name="digest" value="' + escape(proposal.digest) + '">' +
      '<button type="submit" name="action" value="publish">Approve and publish</button> ' +
      '<button type="submit" class="btn-secondary" name="action" value="pr">Open a pull request instead</button></form>' +
      backToOptions(ctx.job));
  }

  async function publish(request, env, current) {
    await limitAttempts(request, env);
    const form = await formData(request);
    assertCsrf(request, form, current, baseUrl(env));
    const digest = form.get('digest'), action = form.get('action');
    const approvalId = form.get('approvalId');
    const redirects = form.has('redirectTicket');
    const raw = form.get(redirects ? 'redirectTicket' : 'seoTicket');
    if (!/^[a-f0-9]{64}$/.test(digest || '') || (action !== 'publish' && action !== 'pr') ||
        form.getAll('approvalId').length + form.getAll('seoTicket').length + form.getAll('redirectTicket').length !== 1)
      return fail('This form is incomplete.', 400);
    let ticket;
    if (raw !== null) {
      if (typeof raw === 'string' && /^[A-Za-z0-9_-]{50,1024}$/.test(raw)) {
        try { ticket = JSON.parse(await unseal(env.TOKEN_ENCRYPTION_KEY, raw, ticketContext(current, redirects))); } catch {}
      }
      if (!ticket || Boolean(ticket.redirectRule) !== redirects || ticket.epoch !== current.authorization_epoch || ticket.digest !== digest ||
          !SHA.test(ticket.baseSha || '') || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= now())
        return fail('This review is unavailable. Open Optional features to review the current files.', 409);
    }
    const ctx = await context(env, current, {approvalId, jobId: ticket?.jobId, redirectRule: ticket?.redirectRule});
    if (!ctx || (ticket && ticket.repositoryId !== ctx.job.repository_id))
      return fail('Open this option from your site options.', 404);
    const grants = await assertHistoryAccess(env, current);
    let result;
    try {
      result = await publishSiteFiles({...ctx.target, approvedDigest: digest, approvedBaseSha: ticket?.baseSha, merge: action === 'publish'}, {
        githubToken: grants.githubAccessToken,
        fetchFn: previewBuildFencedFetch(env, current, ctx.job, grants.cloudflareAccessToken, now)});
    } catch (error) {
      if (error instanceof PreviewBuildPolicyUnavailable)
        return view('Turn off automatic preview builds', '<p>Turn them off in your Cloudflare Pages project and try again.</p>' + backToOptions(ctx.job), 409);
      if (error instanceof SiteFilesRefused) return refusedPage(ctx, error.code);
      throw error;
    }
    const url = /^https:\/\/github\.com\//.test(result.url || '') ? result.url : null;
    const link = url ? ' <a href="' + escape(url) + '">View the pull request</a>.' : '';
    const summary = result.merged
      ? '<p>Added ' + result.files.map(f => '<code>' + escape(f) + '</code>').join(' and ') +
        '. Cloudflare Pages deploys these files from your main branch.' + link + '</p>'
      : '<p>The files are ready in a pull request' + (result.mergeNote ? ', but it could not be merged automatically' : '') +
        '. Merge it in GitHub to publish.' + link + '</p>';
    return view(result.merged ? 'Files merged' : 'Pull request opened', summary + backToOptions(ctx.job));
  }
  return {review, reviewRedirects, publish};
}
