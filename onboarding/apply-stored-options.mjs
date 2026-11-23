// Apply a stored post-launch option. Domain attach only in this slice.
// Email MX enablement and form Worker create stay blocked until their gates exist.
import { matchesApprovedPagesProject } from '../pipeline/approved-pages-project.mjs';
import { validateStoredOptionApproval } from '../pipeline/stored-option-approval.mjs';
import { getFreshAccessToken } from './token-lifecycle.mjs';
import { hasCurrentOwnerSession, isLaunchId } from './launch-jobs.mjs';

const CF = 'https://api.cloudflare.com/client/v4';

async function cfJson(token, url, { method = 'GET', body, fetchFn } = {}) {
  const response = await fetchFn(url, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(12000)
  });
  if (response.status >= 300 && response.status < 400)
    throw Error('Cloudflare redirected unexpectedly');
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success !== true)
    throw Error(json?.errors?.[0]?.message || 'Cloudflare request failed');
  return json.result;
}

function projectName(job) {
  return 'esp-' + job.site_slug + '-site';
}

function repositoryName(job) {
  return 'esp-' + job.site_slug;
}

/**
 * Attach the stored custom hostname to the owner's verified Pages project.
 * Cloudflare may create the DNS record in the customer's zone. This does not
 * change platform DNS (apex/www/mail) and does not write MX.
 */
export async function applyStoredDomainOption(env, {
  job, session, row, assertHistoryAccess, now, fetchFn = fetch
}) {
  if (!job || job.status !== 'live' || !isLaunchId(job.id) ||
      !Number.isSafeInteger(job.repository_id) || job.repository_id < 1 ||
      typeof job.pages_project_id !== 'string' || !job.pages_project_id)
    throw Error('Live verified site required');
  if (!row || row.kind !== 'domain' || row.status !== 'stored')
    throw Error('Stored domain request required');
  if (!await hasCurrentOwnerSession(env, session, now()))
    throw Error('Connected account authorization changed');
  await assertHistoryAccess(env, session);

  const validated = validateStoredOptionApproval(row, {
    jobId: job.id,
    githubUserId: session.github_user_id,
    githubLogin: session.github_login,
    cloudflareAccountId: session.cloudflare_account_id,
    customerName: job.customer_name,
    pagesProjectName: projectName(job)
  });
  if (validated.kind !== 'domain' || validated.canWrite !== false)
    throw Error('Domain request is not executable');
  const hostname = validated.normalizedPayload.hostname;

  const fenced = async (call) => {
    if (!await hasCurrentOwnerSession(env, session, now()))
      throw Error('Connected account authorization changed');
    return call();
  };

  const token = await getFreshAccessToken({
    env, session, provider: 'cloudflare', fetchFn
  });
  const account = session.cloudflare_account_id;
  const name = projectName(job);
  const project = await fenced(() =>
    cfJson(token, CF + '/accounts/' + account + '/pages/projects/' + name, { fetchFn }));
  if (!matchesApprovedPagesProject(project, {
    name,
    projectId: job.pages_project_id,
    owner: session.github_login,
    ownerId: session.github_user_id,
    repositoryName: repositoryName(job),
    repositoryId: job.repository_id,
    branch: 'main'
  })) throw Error('Pages project no longer matches this launch');

  const list = await fenced(() =>
    cfJson(token, CF + '/accounts/' + account + '/pages/projects/' + name + '/domains', { fetchFn }));
  const existing = (Array.isArray(list) ? list : []).find(item => item?.name === hostname);
  let domain = existing;
  if (!domain) {
    domain = await fenced(() =>
      cfJson(token, CF + '/accounts/' + account + '/pages/projects/' + name + '/domains', {
        method: 'POST', body: { name: hostname }, fetchFn
      }));
  }
  if (!domain || domain.name !== hostname)
    throw Error('Cloudflare did not confirm the custom domain');
  return Object.freeze({
    kind: 'domain',
    hostname,
    status: domain.status === 'active' ? 'attached_active' : 'attached_pending_dns',
    dnsWrittenByPlatform: false,
    mxWritten: false,
    pagesProjectId: job.pages_project_id
  });
}

export function blockedOptionApplyReason(kind) {
  if (kind === 'email')
    return 'Email rule create stays blocked until Email Routing is already ready on the customer zone. This path never writes MX.';
  if (kind === 'forms')
    return 'Form Worker create stays blocked until a separate #89 cost and privacy approval record exists.';
  return 'Unknown optional feature.';
}
