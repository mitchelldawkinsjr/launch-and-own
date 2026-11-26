// Visitor insights turn-on (owner decision 2026-11-26): the only two Cloudflare writes it may make.
// 1. POST /accounts/{account}/rum/site_info  {host: '<project>.pages.dev', auto_install: false}
// 2. PATCH /accounts/{account}/pages/projects/{project}  {build_config: managed layout + this site's analytics tag/token}
const HEX = /^[a-f0-9]{32}$/;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const PROJECT = /^[a-z0-9-]{1,58}$/;

export function isApprovedAnalyticsMutation({method, path, requestBody, accountId, pagesProjectName} = {}) {
  if (!ACCOUNT.test(accountId || '') || !PROJECT.test(pagesProjectName || '')) return false;
  const acct = '/accounts/' + accountId;
  if (method === 'POST' && path === acct + '/rum/site_info')
    return Object.keys(requestBody || {}).sort().join(',') === 'auto_install,host' &&
      requestBody.host === pagesProjectName + '.pages.dev' && requestBody.auto_install === false;
  if (method === 'PATCH' && path === acct + '/pages/projects/' + pagesProjectName) {
    const b = requestBody?.build_config;
    return Object.keys(requestBody || {}).join(',') === 'build_config' && !!b && typeof b === 'object' &&
      Object.keys(b).sort().join(',') === 'build_command,destination_dir,root_dir,web_analytics_tag,web_analytics_token' &&
      b.build_command === '' && b.destination_dir === 'public' && b.root_dir === '/' &&
      HEX.test(b.web_analytics_tag) && HEX.test(b.web_analytics_token);
  }
  return false;
}
