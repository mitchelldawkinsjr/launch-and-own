#!/usr/bin/env node
/** Operator query for anonymous onboard funnel counts (Workers Analytics Engine SQL API).
 * Usage: CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node onboarding/funnel-report.mjs [hours]
 * Token needs Account Analytics Read. Dataset: onboarding_funnel. No PII in the query.
 */
const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const hours=Math.min(168,Math.max(1,Number(process.argv[2])||24));
if(!/^[a-f0-9]{32}$/i.test(accountId||'')||!token){
  console.error('Set CLOUDFLARE_ACCOUNT_ID (32 hex) and CLOUDFLARE_API_TOKEN (Analytics Read).');
  process.exit(1);
}
const sql=`SELECT blob1 AS step, sum(double1) AS events
FROM onboarding_funnel
WHERE timestamp>NOW()-INTERVAL '${hours}' HOUR AND index1='onboard'
GROUP BY step
ORDER BY events DESC`;
const url=`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
const res=await fetch(url,{
  method:'POST',
  headers:{authorization:`Bearer ${token}`,'content-type':'text/plain'},
  body:sql
});
const text=await res.text();
if(!res.ok){
  console.error(`Funnel query failed (HTTP ${res.status}):`,text.slice(0,400));
  process.exit(1);
}
console.log(text);
