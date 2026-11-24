import test from 'node:test';
import assert from 'node:assert/strict';
import {planCustomer} from '../pipeline/plan-customer.mjs';
import worker from './worker.mjs';
import {accountId, approvePreview, connectTenant, GENERATED_SHA, harness, jobRow, launchId, makeDue,
 moveLeaseIntoPast, newPreview, originalFetch, post, reviewDigest, writes} from './worker-test-support.mjs';

test('both the review digest and the stored approval must describe the exact approved snapshot',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  const digest=await reviewDigest(h,cookie,id);
  const original=h.sqlite.prepare('SELECT preview_html FROM onboarding_launches WHERE id=?').get(id).preview_html;
  h.sqlite.prepare("UPDATE onboarding_launches SET preview_html=preview_html||'changed' WHERE id=?").run(id);
  assert.equal((await post(h,'/approve',cookie,{csrf,id,digest})).status,400);
  assert.equal(jobRow(h),undefined);
  assert.equal(writes(h).length,0);
  h.sqlite.prepare('UPDATE onboarding_launches SET preview_html=? WHERE id=?').run(original,id);
  assert.equal((await post(h,'/approve',cookie,{csrf,id,digest},{skipFastPath:true})).status,303);
  h.sqlite.prepare("UPDATE onboarding_launch_jobs SET plan_json=plan_json||' ' WHERE id=?").run(id);
  const calls=h.calls.length;
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'failed');
  assert.equal(jobRow(h).error_code,'approval_snapshot_mismatch');
  assert.equal(h.calls.length,calls);
 }finally{globalThis.fetch=originalFetch}
});

test('simultaneous approvals and duplicate scheduled deliveries produce one target and one set of writes',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await connectTenant(h);
  const previews=await Promise.all([newPreview(h,tenant),newPreview(h,tenant)]);
  const digest=await Promise.all(previews.map(id=>reviewDigest(h,tenant.cookie,id)));
  const responses=await Promise.all([0,0,1].map(index=>post(h,'/approve',tenant.cookie,
   {csrf:tenant.csrf,id:previews[index],digest:digest[index]},{skipFastPath:true})));
  assert.equal(responses.filter(response=>response.status===303).length,1);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS count FROM onboarding_launch_jobs').get().count,1);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS count FROM onboarding_launch_job_sessions').get().count,1);
  await Promise.all([worker.scheduled({},h.env),worker.scheduled({},h.env)]);
  const job=jobRow(h);
  assert.equal(job.status,'pending_deployment');
  assert.equal(writes(h).length,3);
  assert.equal(job.expected_commit_sha,GENERATED_SHA);
 }finally{globalThis.fetch=originalFetch}
});

test('lost responses after repo, homepage and Pages creation are reconciled without creating duplicates',async()=>{
 const h=harness();
 const lost=new Set();
 globalThis.fetch=async(url,options)=>{
  const result=await h.fetchFn(url,options);
  if(result.status===201&&!lost.has(url)){
   lost.add(url);
   throw Error('Provider response lost');
  }
  return result;
 };
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  assert.equal((await approvePreview(h,cookie,csrf,id)).status,303);
  assert.equal(jobRow(h).status,'queued');
  assert(h.resourceState.repo);
  for(let retry=0;retry<3;retry++){
   makeDue(h);
   await worker.scheduled({},h.env);
  }
  assert.equal(lost.size,3);
  assert.equal(writes(h).length,3);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
 }finally{globalThis.fetch=originalFetch}
});

test('a new GitHub head cannot replace the pinned revision during recovery',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  h.resourceState.failPagesOnce=true;
  await approvePreview(h,cookie,csrf,id);
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
  const previousWrites=writes(h).length;
  h.resourceState.headSha='f'.repeat(40);
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'failed');
  assert.equal(jobRow(h).error_code,'launch_target_conflict');
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
  assert.equal(writes(h).length,previousWrites);
 }finally{globalThis.fetch=originalFetch}
});

test('an unrelated repository tree cannot be published even with the correct marker',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  h.resourceState.repo={id:101,owner:{login:'tester',id:42},name:'esp-willow-studio',
   description:'Launch & Own managed site: willow-studio [job:'+id+']',private:true,default_branch:'main'};
  h.resourceState.extraTreePath='functions/index.js';
  await approvePreview(h,cookie,csrf,id);
  assert.equal(jobRow(h).status,'failed');
  assert.equal(jobRow(h).error_code,'launch_target_conflict');
  assert.equal(writes(h).length,0);
 }finally{globalThis.fetch=originalFetch}
});

test('disconnect during an admitted repo request fences further work and requires fresh approval', {timeout:5000},async()=>{
 const h=harness();
 let reached,release,approval;
 const entered=new Promise(resolve=>{reached=resolve});
 const blocked=new Promise(resolve=>{release=resolve});
 globalThis.fetch=async(url,options)=>{
  const result=await h.fetchFn(url,options);
  if(url.endsWith('/user/repos')){reached();await blocked}
  return result;
 };
 try{
  const tenant=await connectTenant(h);
  const id=await newPreview(h,tenant);
  approval=approvePreview(h,tenant.cookie,tenant.csrf,id);
  await entered;
  const signOut=await post(h,'/logout',tenant.cookie,{csrf:tenant.csrf});
  assert.equal(signOut.headers.get('location'),'/?disconnect=complete');
  assert.equal(h.sqlite.prepare('SELECT count(*) AS count FROM onboarding_launch_job_sessions').get().count,0);
  release();
  assert.equal((await approval).status,303);
  assert.equal(jobRow(h).status,'needs_reauthorization');
  assert.equal(writes(h).length,1);
  const reconnected=await connectTenant(h);
  assert.equal((await post(h,'/restore',reconnected.cookie,{csrf:reconnected.csrf,id})).status,400);
  moveLeaseIntoPast(h);
  const restored=await post(h,'/restore',reconnected.cookie,{csrf:reconnected.csrf,id});
  assert.equal(restored.status,303);
  assert.equal(writes(h).length,1);
  await approvePreview(h,reconnected.cookie,reconnected.csrf,launchId(restored));
  assert.equal(jobRow(h).id,id);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(writes(h).filter(call=>call.url.endsWith('/user/repos')).length,1);
 }finally{release();if(approval)await approval;globalThis.fetch=originalFetch}
});

test('revoked Cloudflare access is detected before the next GitHub write',async()=>{
 const h=harness();
 globalThis.fetch=async(url,options)=>{
  const result=await h.fetchFn(url,options);
  if(url.endsWith('/user/repos'))h.resourceState.cloudflareRevoked=true;
  return result;
 };
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  await approvePreview(h,cookie,csrf,id);
  assert.equal(writes(h).length,1);
  assert.equal(jobRow(h).status,'needs_reauthorization');
  assert.match(jobRow(h).error_code,/^(provider_(authorization_required|http_\d+|token_refresh_failed)|github_http_\d+|cloudflare(?:_account|_pages)?_http_\d+)/);
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(writes(h).length,1);
  assert.equal((await h.request('/history',{cookie})).status,400);
 }finally{globalThis.fetch=originalFetch}
});

test('changing the selected account away and back invalidates the approved session epoch',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  await approvePreview(h,cookie,csrf,id,{skipFastPath:true});
  assert.equal((await post(h,'/account',cookie,{csrf,accountId:'f'.repeat(32)})).status,303);
  assert.equal((await post(h,'/account',cookie,{csrf,accountId})).status,303);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'needs_reauthorization');
  assert.equal(writes(h).length,0);
 }finally{globalThis.fetch=originalFetch}
});

test('bounded exponential retries exhaust and stay stopped until a new approval',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  h.resourceState.pagesError=503;
  await approvePreview(h,cookie,csrf,id);
  for(const delay of [30,60,120,240]){
   const job=jobRow(h);
   assert.equal(job.status,'queued');
   assert.equal(job.next_attempt_at-job.updated_at,delay);
   makeDue(h);
   await worker.scheduled({},h.env);
  }
  assert.equal(jobRow(h).attempts,5);
  assert.equal(jobRow(h).error_code,'retry_budget_exhausted');
  assert.equal(jobRow(h).status,'failed');
  const writesBeforeRecovery=writes(h).length;
  makeDue(h);
  h.resourceState.pagesError=null;
  await worker.scheduled({},h.env);
  assert.equal(writes(h).length,writesBeforeRecovery);
  const restored=await post(h,'/restore',cookie,{csrf,id});
  assert.equal(restored.status,303);
  await approvePreview(h,cookie,csrf,launchId(restored));
  assert.equal(jobRow(h).id,id);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(writes(h).length,writesBeforeRecovery+1);
 }finally{globalThis.fetch=originalFetch}
});

test('the matching canonical SHA still requires production and the exact approved public bytes',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  await approvePreview(h,cookie,csrf,id);
  const canonical=h.resourceState.pages.canonical_deployment;
  canonical.environment='preview';
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert(!h.calls.some(call=>call.url.endsWith('.pages.dev/')));
  canonical.environment='production';
  h.resourceState.publicHtml='<html>Another page</html>';
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).error_code,'approved_html_not_served');
  assert.equal(jobRow(h).status,'pending_deployment');
  h.resourceState.publicHtml=null;
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'live');
 }finally{globalThis.fetch=originalFetch}
});

test('a replacement Pages project is rejected even if the source and deployed SHA match',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  await approvePreview(h,cookie,csrf,id);
  assert.equal(jobRow(h).pages_project_id,'pages-stable-101');
  h.resourceState.pages.id='different-project';
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'failed');
  assert.equal(jobRow(h).error_code,'launch_target_conflict');
  assert(!h.calls.some(call=>call.url.endsWith('.pages.dev/')));
 }finally{globalThis.fetch=originalFetch}
});

test('an interrupted public response retries verification of the same checkpoint',async()=>{
 const h=harness();
 let interrupt=true;
 globalThis.fetch=async(url,options)=>{
  const response=await h.fetchFn(url,options);
  if(!interrupt||!url.endsWith('.pages.dev/'))return response;
  interrupt=false;
  const stream=new ReadableStream({start(controller){controller.error(Error('Lost public response'))}});
  return new Response(stream,{headers:{'content-type':'text/html'}});
 };
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  await approvePreview(h,cookie,csrf,id);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(jobRow(h).error_code,'provider_unavailable');
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'live');
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
  assert.equal(writes(h).length,3);
 }finally{globalThis.fetch=originalFetch}
});

test('the owner can delete completed history without mutating provider resources',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {cookie,csrf}=await connectTenant(h);
  const id=await newPreview(h,{cookie,csrf});
  await approvePreview(h,cookie,csrf,id);
  assert.equal((await post(h,'/delete-launch-history',cookie,{csrf,id})).status,400);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'live');
  const prior=writes(h).length;
  assert.equal((await post(h,'/delete-launch-history',cookie,{csrf,id})).status,303);
  assert.equal(jobRow(h),undefined);
  assert.equal((await h.request('/review?id='+id,{cookie})).status,404);
  assert.equal(writes(h).length,prior);
  assert(h.resourceState.repo&&h.resourceState.pages);
 }finally{globalThis.fetch=originalFetch}
});

test('migration recovers legacy history and requires explicit reapproval before running it',async()=>{
 const h=harness({withJobs:false});globalThis.fetch=h.fetchFn;
 try{
  const health=await h.request('/health');
  assert.equal(health.status,503);
  assert.equal((await health.json()).launchJobsReady,false);
  const time=Math.floor(Date.now()/1000),legacyId=crypto.randomUUID(),hash='f'.repeat(64);
  const legacyPlan=planCustomer({name:'Willow Studio',accountId,githubOwner:'tester'});
  h.sqlite.prepare(`INSERT INTO onboarding_sessions
   (id_hash,github_user_id,github_login,github_token_ct,cloudflare_account_id,csrf_ct,created_at,expires_at)
   VALUES(?,42,'tester','encrypted',?,'encrypted',?,?)`).run(hash,accountId,time-3600,time-1);
  h.sqlite.prepare(`INSERT INTO onboarding_launches
   (id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,created_at,approved_at,updated_at)
   VALUES(?,?,'Willow Studio',?,'tester',?,'provisioning',?,?,?)`)
   .run(legacyId,hash,accountId,JSON.stringify(legacyPlan),time-3000,time-3000,time-3000);
  h.migrateJobs();
  assert.equal((await h.request('/health')).status,200);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h),undefined);
  assert.equal(writes(h).length,0);
  const receipt=h.sqlite.prepare('SELECT * FROM onboarding_launch_receipts').get();
  assert.equal(receipt.id,legacyId);
  const tenant=await connectTenant(h);
  const restored=await post(h,'/restore',tenant.cookie,{csrf:tenant.csrf,id:legacyId});
  assert.equal(restored.status,303);
  assert.equal(writes(h).length,0);
  h.resourceState.repo={id:101,owner:{id:42,login:'tester'},name:'esp-willow-studio',
   description:'Launch & Own managed site: willow-studio',private:true,default_branch:'main'};
  h.resourceState.homepage=true;
  h.resourceState.homepageHtml=await (await h.request('/site-preview?id='+launchId(restored),{cookie:tenant.cookie})).text();
  await approvePreview(h,tenant.cookie,tenant.csrf,launchId(restored));
  assert.equal(jobRow(h).legacy_receipt_id,legacyId);
  assert.equal(jobRow(h).expires_at,receipt.expires_at);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(writes(h).filter(call=>call.url.endsWith('/user/repos')).length,0);
 }finally{globalThis.fetch=originalFetch}
});
