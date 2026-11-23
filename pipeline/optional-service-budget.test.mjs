import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareOptionalExtensionReview,PUBLISHED_FREE_LIMITS} from './optional-service-budget.mjs';

const now=Math.floor(Date.now()/1000);
const accountId='a'.repeat(32), sha='b'.repeat(40);
const principal=Object.freeze({githubUserId:42,cloudflareAccountId:accountId});
const site=Object.freeze({githubUserId:42,repositoryId:111,
  cloudflareAccountId:accountId,pagesProjectId:'managed-pages-1',
  baseCommitSha:sha,productionBranch:'main'});
const emptyUsage={
  workers:{requestsPerDay:800,cpuMsPerInvocation:4},
  d1:{rowsReadPerDay:1200,rowsWrittenPerDay:120,storedGb:0.2,databases:1},
  kv:{readsPerDay:100,writesPerDay:20,deletesPerDay:5,listsPerDay:2,
    storedGb:0.05,namespaces:1},
  r2:{standardGbMonthsPerMonth:2,classAOpsPerMonth:100,classBOpsPerMonth:2000}
};
const fullGrants={workers:true,d1:true,kv:true,r2:true};
const accountEvidence={kind:'verified-account-plan-and-usage',
  githubUserId:42,cloudflareAccountId:accountId,
  workersPlan:'free',checkedAt:now-30,expiresAt:now+600,
  r2SubscriptionActive:false,usageByService:emptyUsage,
  permissions:fullGrants};
const service=(name,forecast,extras={})=>({
  service:name,purpose:'site-settings',dataClassification:'none',
  deletionPlan:'none',retentionDays:0,
  customerResourceScope:'customer-owned-dedicated',
  ...(name==='r2'?{storageClass:'standard'}:{}),
  projectedUsage:forecast,...extras
});
const reqWorkers=service('workers',{requestsPerDay:1200,cpuMsPerInvocation:6});
const reqD1=service('d1',{rowsReadPerDay:40000,rowsWrittenPerDay:1000,storedGb:0.5,databases:1},
  {purpose:'contact-submissions',dataClassification:'personal',
   deletionPlan:'time-bound',retentionDays:30});
const reqKV=service('kv',{readsPerDay:1000,writesPerDay:70,
  deletesPerDay:5,listsPerDay:10,storedGb:0.1,namespaces:1});
const reqR2=service('r2',{standardGbMonthsPerMonth:1,
  classAOpsPerMonth:2000,classBOpsPerMonth:5000},
  {purpose:'media-uploads',dataClassification:'private',
   deletionPlan:'owner-delete',retentionDays:30});
const args={principal,site,accountEvidence,requests:[reqWorkers]};
const plan=(changes={},opts={})=>prepareOptionalExtensionReview({...args,...changes},{now,...opts});

test('published Free caps are separate per-service units and immutable',()=>{
 assert.deepEqual(Object.keys(PUBLISHED_FREE_LIMITS),['workers','d1','kv','r2']);
 assert.equal(PUBLISHED_FREE_LIMITS.workers.metrics.requestsPerDay,100000);
 assert.equal(PUBLISHED_FREE_LIMITS.workers.metrics.cpuMsPerInvocation,10);
 assert.equal(PUBLISHED_FREE_LIMITS.d1.metrics.rowsReadPerDay,5000000);
 assert.equal(PUBLISHED_FREE_LIMITS.d1.metrics.rowsWrittenPerDay,100000);
 assert.equal(PUBLISHED_FREE_LIMITS.kv.metrics.writesPerDay,1000);
 assert.equal(PUBLISHED_FREE_LIMITS.r2.metrics.standardGbMonthsPerMonth,10);
 for(const catalog of Object.values(PUBLISHED_FREE_LIMITS)){
  assert(Object.isFrozen(catalog));assert(Object.isFrozen(catalog.metrics));
  assert(catalog.documentation.startsWith('https://developers.cloudflare.com/'));
 }
});

test('under Free allowance remains a review-only, non-activatable estimate',async()=>{
 const result=await plan();
 assert.equal(result.state,'review_only_not_activatable');
 assert.equal(result.canActivate,false);assert.equal(result.canWrite,false);
 assert.equal(result.costEstimateUsd,null);
 assert.equal(result.services.length,1);
 assert.equal(result.services[0].service,'workers');
 assert.equal(result.services[0].state,'estimated_within_published_free_allowance');
 assert.equal(result.services[0].projectedAccountUsage.requestsPerDay,2000);
 assert.equal(result.services[0].estimatedFreeHeadroom.requestsPerDay,98000);
 assert.equal(result.services[0].estimatedFreeHeadroom.cpuMsPerInvocation,4);
 assert.equal(result.services[0].readyForActivation,false);
 assert.match(result.planDigest,/^[a-f0-9]{64}$/);
 assert.equal(result.planDigest,(await plan()).planDigest);
 assert(result.warnings.some(x=>x.includes('not a $0 guarantee')));
 assert(Object.isFrozen(result));assert(Object.isFrozen(result.services));
 assert(Object.isFrozen(result.services[0]));
 assert(!JSON.stringify(result).includes(accountId));
 assert(!JSON.stringify(result).includes(sha));
});

test('all four optional services are classified individually, independent of publication',async()=>{
 const result=await plan({requests:[reqR2,reqKV,reqD1,reqWorkers]});
 assert.equal(result.state,'review_only_not_activatable');
 assert.deepEqual(result.services.map(s=>s.service),['workers','d1','kv','r2']);
 assert.deepEqual(result.services.map(s=>s.state),[
  'estimated_within_published_free_allowance',
  'estimated_within_published_free_allowance',
  'estimated_within_published_free_allowance',
  'subscription_activation_required'
 ]);
 assert(result.services.every(s=>s.readyForActivation===false&&s.costEstimateUsd===null));
 assert.equal(result.services[1].projectedAccountUsage.rowsWrittenPerDay,1120);
 assert.equal(result.services[3].reason,'r2_requires_separate_subscription_checkout');
});

test('R2 Standard subscription is never activated or advertised as guaranteed free',async()=>{
 const without=await plan({requests:[reqR2]});
 assert.equal(without.services[0].state,'subscription_activation_required');
 const withSubscription=await plan({requests:[reqR2],
  accountEvidence:{...accountEvidence,r2SubscriptionActive:true}});
 assert.equal(withSubscription.services[0].state,'billing_review_required');
 assert.equal(withSubscription.services[0].costEstimateUsd,null);
 assert.equal(withSubscription.canActivate,false);
 const infrequent=await plan({requests:[{...reqR2,storageClass:'infrequent'}]});
 assert.equal(infrequent.state,'blocked_permission_or_plan');
 assert.equal(infrequent.reason,'invalid_or_duplicate_service_plan');
});

test('already-used account allowance is included and overflow blocks Free claims',async()=>{
 const nearLimit={...emptyUsage,kv:{...emptyUsage.kv,writesPerDay:990}};
 const result=await plan({requests:[reqKV],
  accountEvidence:{...accountEvidence,usageByService:nearLimit}});
 assert.equal(result.services[0].state,'projected_free_allowance_exceeded');
 assert.equal(result.services[0].projectedAccountUsage.writesPerDay,1060);
 assert.equal(result.services[0].estimatedFreeHeadroom.writesPerDay,0);
 assert.equal(result.canActivate,false);
});

test('unknown aggregate usage/permission is a blocker, not a zero-usage guess',async()=>{
 for(const evidence of [
  {...accountEvidence,usageByService:{...emptyUsage,workers:undefined}},
  {...accountEvidence,usageByService:{...emptyUsage,workers:{requestsPerDay:undefined,cpuMsPerInvocation:0}}}
 ]){
  const result=await plan({accountEvidence:evidence});
  assert.equal(result.services[0].state,'usage_unverified');
  assert.equal(result.services[0].estimatedFreeHeadroom,null);
 }
 const disabled=await plan({accountEvidence:{...accountEvidence,
  permissions:{...fullGrants,workers:false}}});
 assert.equal(disabled.services[0].state,'blocked_permission_or_plan');
 assert.equal(disabled.services[0].reason,'service_scope_not_verified');
 assert.equal(disabled.services[0].measuredAccountUsage,null);
});

test('Paid account must receive a separate price/billing review',async()=>{
 const result=await plan({accountEvidence:{...accountEvidence,workersPlan:'paid',
  r2SubscriptionActive:true},requests:[reqWorkers,reqD1,reqKV,reqR2]});
 assert(result.services.every(s=>s.state==='paid_cost_review_required'));
 assert(result.services.every(s=>s.costEstimateUsd===null&&s.readyForActivation===false));
 assert.equal(result.costEstimateUsd,null);
 const withoutR2Activation=await plan({accountEvidence:{...accountEvidence,workersPlan:'paid'},
   requests:[reqR2]});
 assert.equal(withoutR2Activation.services[0].state,'subscription_activation_required');
});

test('tenant, repository and Cloudflare account mismatches fail closed',async()=>{
 const bad=[
  {principal:{...principal,githubUserId:99}},
  {principal:{...principal,cloudflareAccountId:'c'.repeat(32)}},
  {site:{...site,repositoryId:0}},
  {site:{...site,baseCommitSha:'x'}},
  {site:{...site,productionBranch:'develop'}},
  {site:{...site,pagesProjectId:'https://bad.example'}},
  {accountEvidence:{...accountEvidence,githubUserId:99}},
  {accountEvidence:{...accountEvidence,cloudflareAccountId:'d'.repeat(32)}}
 ];
 for(const change of bad){
  const result=await plan(change);
  assert.equal(result.state,'blocked_permission_or_plan');
  assert.deepEqual(result.services,[]);
  assert.equal(result.planDigest,null);
 }
});

test('stale, future and externally asserted usage are not treated as verified',async()=>{
 for(const evidence of [
  {...accountEvidence,kind:'client-asserted'},
  {...accountEvidence,checkedAt:now+5},
  {...accountEvidence,checkedAt:now-901},
  {...accountEvidence,expiresAt:now-1},
  {...accountEvidence,expiresAt:now+86400},
  {...accountEvidence,workersPlan:'enterprise_unknown'},
  {...accountEvidence,permissions:undefined}
 ]){
  const result=await plan({accountEvidence:evidence});
  assert.equal(result.reason,'fresh_verified_account_plan_and_usage_required');
  assert.deepEqual(result.services,[]);
 }
});

test('reject unsupported/duplicate services, platform staging and invalid forecasts',async()=>{
 for(const requests of [
  [],[reqWorkers,reqWorkers],
  [{...reqWorkers,service:'pages-static'}],
  [{...reqWorkers,customerResourceScope:'platform-zip-staging'}],
  [{...reqWorkers,projectedUsage:{requestsPerDay:NaN,cpuMsPerInvocation:8}}],
  [{...reqWorkers,projectedUsage:{requestsPerDay:-1,cpuMsPerInvocation:8}}],
  [{...reqWorkers,projectedUsage:{requestsPerDay:Infinity,cpuMsPerInvocation:8}}],
  [{...reqWorkers,projectedUsage:{requestsPerDay:5,cpuMsPerInvocation:8,extra:99}}],
  [{...reqWorkers,dataClassification:'personal',retentionDays:0}],
  [{...reqWorkers,dataClassification:'personal',retentionDays:30,deletionPlan:'owner-delete'}],
  [{...reqWorkers,retentionDays:500}],
  [{...reqWorkers,purpose:'mine-user-data'}],
  [{...reqD1,deletionPlan:'none'}],
  [{...reqR2,storageClass:'infrequent'}],
  [reqWorkers,reqD1,reqKV,reqR2,reqWorkers]
 ]){
  const result=await plan({requests});
  assert.equal(result.state,'blocked_permission_or_plan');
  assert.equal(result.canWrite,false);
  assert.deepEqual(result.services,[]);
 }
});

test('digest binds current source, requested retention, account limits and intent',async()=>{
 const base=await plan();
 const diffs=[
  await plan({site:{...site,baseCommitSha:'c'.repeat(40)}}),
  await plan({site:{...site,repositoryId:112}}),
  await plan({requests:[{...reqWorkers,purpose:'lightweight-api'}]}),
  await plan({requests:[{...reqWorkers,projectedUsage:{...reqWorkers.projectedUsage,requestsPerDay:1400}}]}),
  await plan({accountEvidence:{...accountEvidence,usageByService:{...emptyUsage,
    workers:{...emptyUsage.workers,requestsPerDay:801}}}}),
  await plan({accountEvidence:{...accountEvidence,checkedAt:now-20}})
 ];
 for(const res of diffs){
  assert.equal(res.state,'review_only_not_activatable');
  assert.notEqual(res.planDigest,base.planDigest);
 }
});

test('mutating a bound owner, forecast or usage during digest invalidates the plan',async()=>{
 for(const change of [
  state=>{state.site.repositoryId=443;},
  state=>{state.principal.cloudflareAccountId='d'.repeat(32);},
  state=>{state.account.workersPlan='paid';},
  state=>{state.account.usageByService.workers.requestsPerDay=999;},
  state=>{state.requests[0].projectedUsage.requestsPerDay=999;}
 ]){
  const state={principal:{...principal},site:{...site},
    account:{...accountEvidence,usageByService:{...emptyUsage,
      workers:{...emptyUsage.workers}},permissions:{...fullGrants}},
    requests:[{...reqWorkers,projectedUsage:{...reqWorkers.projectedUsage}}]};
  const pending=prepareOptionalExtensionReview({
    principal:state.principal,site:state.site,accountEvidence:state.account,
    requests:state.requests},{now});
  change(state);
  const result=await pending;
  assert.equal(result.state,'blocked_permission_or_plan');
  assert.equal(result.reason,'account_or_forecast_changed_during_review');
  assert.equal(result.planDigest,null);
 }
});
