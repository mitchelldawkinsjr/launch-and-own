import { sameBytes, sha256Bytes } from './bytes.mjs';
import { ImportedEditError } from './errors.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const PROJECT = /^esp-[a-z0-9-]{1,40}-site$/;

// Pages 308-redirects /index.html to / and /about.html to /about, so request the address it actually serves.
export function servedPath(path) {
  if (path === 'index.html') return '';
  if (path.endsWith('/index.html')) return path.slice(0, -'index.html'.length);
  return path.endsWith('.html') ? path.slice(0, -'.html'.length) : path;
}

export function assessPublishedRevision({ expectedCommitSha, project }) {
  if (typeof expectedCommitSha !== 'string' || !SHA.test(expectedCommitSha)) throw new ImportedEditError('revision-unreadable');
  const canonical = project?.canonical_deployment;
  const stage = canonical?.latest_stage;
  const reported = canonical?.deployment_trigger?.metadata?.commit_hash;
  const deployedCommit = typeof reported === 'string' && SHA.test(reported) ? reported.toLowerCase() : null;
  const production = canonical?.environment === 'production';
  if (stage?.name !== 'deploy' || stage?.status !== 'success' || !production) {
    return { live: false, status: 'deploying', deployedCommit };
  }
  if (deployedCommit !== expectedCommitSha.toLowerCase()) {
    return { live: false, status: 'deploy_unverified', deployedCommit };
  }
  return { live: true, status: 'live', deployedCommit };
}

export async function verifyPublishedRevision({ accountId, projectName, expectedCommitSha, cloudflareToken, fetchFn = fetch, publicUrl, expectedBytes, changedFiles }) {
  if (!ACCOUNT.test(accountId || '') || !PROJECT.test(projectName || '') || typeof cloudflareToken !== 'string' || !cloudflareToken) {
    throw new ImportedEditError('verification-target-required');
  }
  const response = await fetchFn('https://api.cloudflare.com/client/v4/accounts/' + accountId + '/pages/projects/' + projectName, {
    method: 'GET', redirect: 'manual',
    headers: { authorization: 'Bearer ' + cloudflareToken, accept: 'application/json' }
  });
  if (!response.ok) throw new ImportedEditError('verification-unreadable');
  const payload = await response.json().catch(() => { throw new ImportedEditError('verification-unreadable'); });
  if (!payload?.success || payload.result?.name !== projectName) throw new ImportedEditError('verification-unreadable');
  const assessed = assessPublishedRevision({ expectedCommitSha, project: payload.result });
  if (!assessed.live || (expectedBytes === undefined && !Array.isArray(changedFiles))) return assessed;
  if (typeof publicUrl !== 'string' || !publicUrl.startsWith('https://')) throw new ImportedEditError('verification-target-required');
  if (Array.isArray(changedFiles)) {
    const root = publicUrl.endsWith('/') ? publicUrl : publicUrl + '/';
    for (const file of changedFiles) {
      const path = String(file?.path || '').replace(/^public\//, '');
      if (!path || path.includes('..') || typeof file.sha256 !== 'string') {
        return { live: false, status: 'deploy_unverified', deployedCommit: assessed.deployedCommit };
      }
      const page = await fetchFn(root + servedPath(path).split('/').map(encodeURIComponent).join('/'), { method: 'GET', redirect: 'manual' });
      if (page.status !== 200) return { live: false, status: 'deploy_unverified', deployedCommit: assessed.deployedCommit };
      const bytes = new Uint8Array(await page.arrayBuffer());
      if (await sha256Bytes(bytes) !== file.sha256) return { live: false, status: 'deploy_unverified', deployedCommit: assessed.deployedCommit };
    }
    return assessed;
  }
  const page = await fetchFn(publicUrl, { method: 'GET', redirect: 'manual' });
  if (page.status !== 200) return { live: false, status: 'deploy_unverified', deployedCommit: assessed.deployedCommit };
  const bytes = new Uint8Array(await page.arrayBuffer());
  if (!sameBytes(bytes, expectedBytes)) return { live: false, status: 'deploy_unverified', deployedCommit: assessed.deployedCommit };
  return assessed;
}
