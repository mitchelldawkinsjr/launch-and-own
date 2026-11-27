// Owner turn-on for SEO and redirects (owner decision 2026-11-26): review the exact new files, then
// "Approve and publish" (or open a PR instead). Only adds files; never edits an existing page.
import { readOwnedStoredOptionApproval } from './stored-option-approvals.mjs';
import { getOwnedJob } from './launch-jobs.mjs';
import { buildSiteFilesProposal } from '../pipeline/site-files-proposal.mjs';
import { publishSiteFiles, readSiteFiles, SiteFilesRefused } from '../pipeline/publish-site-files.mjs';
import { PreviewBuildPolicyUnavailable, ownerFencedFetch, previewBuildFencedFetch } from './site-update-flow.mjs';

const KINDS = new Set(['seo', 'redirects']);
const LABEL = {seo: 'search engine files', redirects: 'redirects'};
const REASON = {
  file_exists: 'your site already has this file. Edit it in your site\'s files instead; Launch & Own never replaces it.',
  no_pages: 'no HTML pages were found in your site\'s public folder.',
  too_many_pages: 'your site has more than 1,000 pages; add a sitemap by hand.',
  www_redirect_unsupported: 'www/apex redirects need DNS changes and stay manual.',
  unsafe_rule: 'a saved redirect is not a same-site path. Save a new redirect request.',
  no_rules: 'the saved request has no redirect rules. Save a new redirect request.',
  approval_digest_mismatch: 'your site changed since you reviewed the files. Review them again.',
  repository_mismatch: 'the GitHub repository no longer matches this site.',
  credentials_revoked: 'GitHub access changed. Reconnect and try again.'
};

export function siteFilesEnabled(env) {
  return env.OPTION_OWNER_ACTIVATION_ENABLED === 'true' && env.OPTION_SITE_FILES_ENABLED === 'true';
}

export function createSiteFilesRoutes({view, fail, escape, formData, assertCsrf, baseUrl, assertHistoryAccess, limitAttempts, now}) {
  async function context(env, current, approvalId) {
    if (!siteFilesEnabled(env)) return null;
    const reviewed = await readOwnedStoredOptionApproval(env, current, approvalId);
    if (!reviewed || !KINDS.has(reviewed.kind)) return null;
    const job = await getOwnedJob(env, current, reviewed.jobId, now());
    if (!job || job.status !== 'live' || job.repository_id !== reviewed.currentSite.repositoryId) return null;
    // Canonical origin: the custom domain this owner turned on for this site, else the site's own pages.dev address.
    const domain = await env.DB.prepare("SELECT payload_json FROM onboarding_option_executions WHERE job_id = ? AND " +
      "github_user_id = ? AND kind = 'domain' AND status = 'applied' ORDER BY updated_at DESC LIMIT 1")
      .bind(job.id, current.github_user_id).first();
    let host = reviewed.currentSite.pagesProjectName + '.pages.dev';
    try { const h = JSON.parse(domain?.payload_json || 'null')?.hostname; if (/^[a-z0-9.-]+$/.test(h || '')) host = h; } catch {}
    const target = {owner: job.github_login, repoName: reviewed.currentSite.repositoryName, repositoryId: job.repository_id,
      propose: paths => buildSiteFilesProposal({kind: reviewed.kind, payload: reviewed.normalizedPayload, paths, origin: 'https://' + host})};
    return {reviewed, job, target};
  }
  const refusedPage = (kind, code) => fail('The ' + LABEL[kind] + ' could not be added: ' +
    escape(REASON[code] || 'please reopen your site options and try again.') + ' Nothing was changed.', 409);

  async function review(env, current, approvalId) {
    const ctx = await context(env, current, approvalId);
    if (!ctx) return fail('Open this option from your site options.', 404);
    const grants = await assertHistoryAccess(env, current);
    let proposal;
    try { ({proposal} = await readSiteFiles(ctx.target, {githubToken: grants.githubAccessToken, fetchFn: ownerFencedFetch(env, current, now)})); }
    catch (error) { if (error instanceof SiteFilesRefused) return refusedPage(ctx.reviewed.kind, error.code); throw error; }
    if (!proposal.ok) return refusedPage(ctx.reviewed.kind, proposal.reason);
    return view('Turn on ' + LABEL[ctx.reviewed.kind],
      '<p>These new files will be added to your website. No existing page or file is changed.</p>' +
      proposal.files.map(f => '<h2><code>' + escape(f.path) + '</code></h2><pre>' + escape(f.content) + '</pre>').join('') +
      '<p><strong>Approve and publish</strong> commits exactly these files to your site\'s <code>main</code> branch and merges it, ' +
      'after confirming automatic Cloudflare Pages preview builds are off. Prefer to review it in GitHub first? Choose ' +
      '<strong>Open a pull request instead</strong>.</p>' +
      '<form action="/site-options-files-publish" method="POST"><input type="hidden" name="csrf" value="' + escape(current.csrf) + '">' +
      '<input type="hidden" name="approvalId" value="' + escape(approvalId) + '">' +
      '<input type="hidden" name="digest" value="' + escape(proposal.digest) + '">' +
      '<button type="submit" name="action" value="publish">Approve and publish</button> ' +
      '<button type="submit" name="action" value="pr" class="btn-secondary">Open a pull request instead</button></form>' +
      '<p><a href="/site-options?id=' + encodeURIComponent(ctx.job.id) + '">Back to site options</a></p>');
  }

  async function publish(request, env, current) {
    await limitAttempts(request, env);
    const form = await formData(request);
    assertCsrf(request, form, current, baseUrl(env));
    const digest = form.get('digest'), action = form.get('action');
    if (!/^[a-f0-9]{64}$/.test(digest || '') || (action !== 'publish' && action !== 'pr'))
      return fail('This form is incomplete.', 400);
    const ctx = await context(env, current, form.get('approvalId'));
    if (!ctx) return fail('Open this option from your site options.', 404);
    const grants = await assertHistoryAccess(env, current);
    let result;
    try {
      result = await publishSiteFiles({...ctx.target, approvedDigest: digest, merge: action === 'publish'}, {
        githubToken: grants.githubAccessToken,
        fetchFn: previewBuildFencedFetch(env, current, ctx.job, grants.cloudflareAccessToken, now)});
    } catch (error) {
      if (error instanceof PreviewBuildPolicyUnavailable)
        return fail('Nothing was changed. Turn off automatic preview builds in your Cloudflare Pages project, then try again.', 409);
      if (error instanceof SiteFilesRefused) return refusedPage(ctx.reviewed.kind, error.code);
      throw error;
    }
    const url = /^https:\/\/github\.com\//.test(result.url || '') ? result.url : null;
    const link = url ? ' <a href="' + escape(url) + '">View the pull request</a>.' : '';
    return view(result.merged ? 'Published' : 'Pull request opened', result.merged
      ? '<p>Added ' + result.files.map(f => '<code>' + escape(f) + '</code>').join(' and ') +
        '. Cloudflare Pages publishes them in a minute or two.' + link + '</p>'
      : '<p>The files are ready in a pull request' + (result.mergeNote ? ', but it could not be merged automatically' : '') +
        '. Merge it in GitHub to publish.' + link + '</p>');
  }
  return {review, publish};
}
