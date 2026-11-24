/** Owner-facing fallback when optional-service account usage is unavailable. */
const ACCOUNT_DASHBOARD = /^https:\/\/dash\.cloudflare\.com\/[a-fA-F0-9]{32}$/;

export function renderToolkitUsage(result, {escape}) {
  const heading = '<section><h2>Plans and limits</h2>';
  if (typeof result?.usageDashboardUrl !== 'string' || !ACCOUNT_DASHBOARD.test(result.usageDashboardUrl))
    return heading + '<p>Reconnect your accounts to check this site’s plan and usage.</p></section>';
  const {workers, d1, kv, r2} = result.publishedFreeLimits;
  const count = value => new Intl.NumberFormat('en-US').format(value);
  const sources = [
    ['Workers', count(workers.metrics.requestsPerDay) + ' requests/day and ' +
      workers.metrics.cpuMsPerInvocation + ' ms CPU/invocation', workers.documentation],
    ['D1', count(d1.metrics.rowsReadPerDay) + ' rows read/day and ' +
      count(d1.metrics.rowsWrittenPerDay) + ' rows written/day', d1.documentation],
    ['KV', count(kv.metrics.readsPerDay) + ' reads/day and ' +
      count(kv.metrics.writesPerDay) + ' writes/day', kv.documentation],
    ['R2 Standard', r2.metrics.standardGbMonthsPerMonth + ' GB-month of storage. Account subscription required',
      r2.documentation]
  ];
  const limits = sources.map(([name, allowance, documentation]) =>
    '<li><a href="' + escape(documentation) + '" rel="noreferrer">' + escape(name) +
    '</a> · ' + escape(allowance) + '</li>').join('');
  return heading + '<p>Static Pages hosting works without these optional services.</p>' +
    '<p>Check your plan and usage in Cloudflare before approving an extension. ' +
    'These published Free allowances are shared account limits. Your remaining allowance is unavailable here.</p>' +
    '<ul>' + limits + '</ul><p><a href="' + escape(result.usageDashboardUrl) +
    '" rel="noreferrer">Open Cloudflare account</a></p></section>';
}
