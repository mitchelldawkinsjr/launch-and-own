import test from 'node:test';
import assert from 'node:assert/strict';
import {accountId,approvePreview,connectTenant,GENERATED_SHA,harness,newPreview,originalFetch,post,csrfFrom} from './worker-test-support.mjs';

const UPDATE_COMMIT='f'.repeat(40);
const PROJECT='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/pages/projects/esp-willow-studio-site';
async function liveSite(h){
  const tenant=await connectTenant(h);
  const id=await newPreview(h,tenant,{tagline:'Original homepage headline'});
  assert.equal((await approvePreview(h,tenant.cookie,tenant.csrf,id)).status,303);
  assert.equal((await post(h,'/verify',tenant.cookie,{csrf:tenant.csrf,id})).status,303);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launch_jobs').get().status,'live');
  return {...tenant,id};
}
async function reviewedEdit(h,tenant,fields={}){
  const result=await post(h,'/site-update-preview',tenant.cookie,{
    csrf:tenant.csrf,id:tenant.id,tagline:'New customer-approved headline',
    about:'We photograph families in our community.',services:'Portraits\nEvents',
    theme:'forest',contactEmail:'owner@example.com',...fields
  });
  assert.equal(result.status,303);
  const location=result.headers.get('location');
  assert.match(location,/^\/site-update-review\?ticket=/);
  return new URL('https://onboard.example.com'+location).searchParams.get('ticket');
}
function updateWrites(h){
  return h.calls.filter(x=>x.method==='PUT'||x.url.endsWith('/git/refs')||x.url.endsWith('/pulls'));
}

test('only a verified live one-page site offers editing; no provider write on opening or previewing',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  assert.equal((await h.request('/site-update?id='+crypto.randomUUID())).status,404);
  const tenant=await connectTenant(h);
  const unfinished=await newPreview(h,tenant);
  assert.equal((await h.request('/site-update?id='+unfinished,{cookie:tenant.cookie})).status,404);
  await approvePreview(h,tenant.cookie,tenant.csrf,unfinished);
  await post(h,'/verify',tenant.cookie,{csrf:tenant.csrf,id:unfinished});
  const history=await (await h.request('/history',{cookie:tenant.cookie})).text();
  assert.match(history,/Update this website/);
  const editor=await h.request('/site-update?id='+unfinished,{cookie:tenant.cookie});
  assert.equal(editor.status,200);
  assert.match(await editor.text(),/Original|welcoming place/);
  const ticket=await reviewedEdit(h,{...tenant,id:unfinished});
  const review=await h.request('/site-update-review?ticket='+ticket,{cookie:tenant.cookie});
  assert.equal(review.status,200);
  const reviewHtml=await review.text();
  assert.match(reviewHtml,/value="publish">Approve and publish</);
  assert.match(reviewHtml,/value="pr">Open a pull request instead</);
  const exact=await h.request('/site-update-html?ticket='+ticket,{cookie:tenant.cookie});
  assert.equal(exact.status,200);
  assert.match(await exact.text(),/New customer-approved headline/);
  assert.equal(exact.headers.get('referrer-policy'),'no-referrer');
  assert.equal(exact.headers.get('cache-control'),'private, no-store');
  assert.equal(h.resourceState.updateBranch,null);
  assert.equal(h.resourceState.updatePr,null);
 }finally{globalThis.fetch=originalFetch}
});

test('separate approved edit creates only a feature branch and PR; customer merge and exact live content verified',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),before=h.resourceState.homepageHtml;
  const ticket=await reviewedEdit(h,tenant);
  const beforeWrites=updateWrites(h).length;
  const beforeApproval=h.calls.length;
  const approval=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(approval.status,303);
  const approvalCalls=h.calls.slice(beforeApproval);
  const writeIndexes=approvalCalls.flatMap((call,index)=>call.method==='GET'?[]:[index]);
  assert.equal(writeIndexes.length,3);
  for(const index of writeIndexes)
   assert.deepEqual(approvalCalls[index-1],{method:'GET',url:PROJECT});
  assert.match(h.resourceState.updateBranch,/^launch-and-own\/site-/);
  assert(h.resourceState.updatePr);
  assert.equal(h.resourceState.homepageHtml,before,'main website must not be directly edited');
  assert.equal(h.resourceState.updateFileWrites,1);
  assert(updateWrites(h).length>beforeWrites);
  const statusPath=approval.headers.get('location');
  let status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.equal(status.status,200);
  let statusHtml=await status.text();
  assert.match(statusHtml,/Open the change to publish/);
  assert.match(statusHtml,/Publish in GitHub/);
  h.resourceState.updatePr.head.sha='2'.repeat(40);
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.equal(status.status,200);
  const changedHtml=await status.text();
  assert.match(changedHtml,/change request version differs from your approval/);
  assert.doesNotMatch(changedHtml,/Open the change to publish|href="https:\/\/github\.com/);
  h.resourceState.updatePr.head.sha=UPDATE_COMMIT;
  h.resourceState.updatePr={...h.resourceState.updatePr,state:'closed'};
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.equal(status.status,200);
  const closedHtml=await status.text();
  assert.match(closedHtml,/Start a fresh edit/);
  assert.doesNotMatch(closedHtml,/Open the change to publish|href="https:\/\/github\.com/);
  h.resourceState.updatePr={...h.resourceState.updatePr,state:'closed',
    merged_at:'2026-11-22T19:00:00Z',merge_commit_sha:UPDATE_COMMIT};
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.match(await status.text(),/Checking your live site/);
  h.resourceState.pages.canonical_deployment.deployment_trigger.metadata.commit_hash=UPDATE_COMMIT;
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.match(await status.text(),/Checking your live site/);
  h.resourceState.publicHtml=h.resourceState.updateHtml;
  status=await h.request(statusPath,{cookie:tenant.cookie});
  const html=await status.text();
  assert.match(html,/Live and checked/);
  assert.match(html,/esp-willow-studio-site.pages.dev/);
  h.resourceState.pages.id='replacement-with-the-same-source';
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.equal(status.status,400);
  assert.doesNotMatch(await status.text(),/Live and checked/);
 }finally{globalThis.fetch=originalFetch}
});

test('a public, scoped or unknown preview policy blocks the first GitHub write',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  const beforeWrites=updateWrites(h).length;
  const config=h.resourceState.pages.source.config;
  config.preview_branch_includes=['launch-and-own/site-*'];
  config.preview_branch_excludes=['main'];
  config.pr_comments_enabled=false;
  for(const setting of ['all','custom',undefined]){
   config.preview_deployment_setting=setting;
   const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
   assert.equal(r.status,409);
   assert.match(await r.text(),/Confirm automatic preview builds are disabled/);
   assert.equal(updateWrites(h).length,beforeWrites);
  }
  assert.equal(h.resourceState.updateBranch,null);
  assert.equal(h.resourceState.updatePr,null);
  const exact=await h.request('/site-update-html?ticket='+ticket,{cookie:tenant.cookie});
  assert.equal(exact.status,200);
  assert.match(await exact.text(),/New customer-approved headline/);
 }finally{globalThis.fetch=originalFetch;h.sqlite.close()}
});

test('a replacement Pages project with preview builds off cannot authorize a GitHub update',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  h.resourceState.pages.id='replacement-with-the-same-source';
  const beforeWrites=updateWrites(h).length;
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(r.status,409);
  assert.match(await r.text(),/Confirm automatic preview builds are disabled/);
  assert.equal(updateWrites(h).length,beforeWrites);
  assert.equal(h.resourceState.updateBranch,null);
 }finally{globalThis.fetch=originalFetch;h.sqlite.close()}
});

test('a preview policy change after branch or content staging stops the next write',async()=>{
 for(const point of [
  {suffix:'/git/refs',method:'POST',setting:'all',fileWrites:0},
  {suffix:'/contents/public/index.html',method:'PUT',setting:undefined,fileWrites:1}
 ]){
  const h=harness();globalThis.fetch=h.fetchFn;
  try{
   const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
   globalThis.fetch=async(url,options)=>{
    const response=await h.fetchFn(url,options);
    if(url.endsWith(point.suffix)&&options.method===point.method)
     h.resourceState.pages.source.config.preview_deployment_setting=point.setting;
    return response;
   };
   const paused=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
   assert.equal(paused.status,409);
   assert.match(await paused.text(),/The update paused before the next GitHub change/);
   assert.match(h.resourceState.updateBranch,/^launch-and-own\/site-/);
   assert.equal(h.resourceState.updateFileWrites,point.fileWrites);
   assert.equal(h.resourceState.updatePr,null);

   globalThis.fetch=h.fetchFn;
   h.resourceState.pages.source.config.preview_deployment_setting='none';
   const retried=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
   assert.equal(retried.status,303);
   assert.equal(h.calls.filter(x=>x.url.endsWith('/git/refs')).length,1);
   assert.equal(h.resourceState.updateFileWrites,1);
   assert.equal(h.calls.filter(x=>x.url.endsWith('/pulls')&&x.method==='POST').length,1);
  }finally{globalThis.fetch=originalFetch;h.sqlite.close()}
 }
});

test('approval reuses freshly renewed GitHub and Cloudflare grants',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  h.resourceState.issueExpiringGrants=true;
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  h.sqlite.prepare('UPDATE onboarding_sessions SET github_token_expires_at=1, cloudflare_token_expires_at=1').run();
  const afterPreview=h.calls.length;
  const pagesReads=[];
  let dbQueries=0,rateLimitChecks=0;
  const prepare=h.DB.prepare;
  h.DB.prepare=sql=>{dbQueries++;return prepare(sql)};
  h.env.ONBOARDING_LIMITER.limit=async()=>{rateLimitChecks++;return {success:true}};
  globalThis.fetch=async(url,options)=>{
   if(url===PROJECT)
    pagesReads.push({bearer:options.headers.authorization,cache:options.cache});
   if(url.startsWith('https://api.github.com/repos/')&&options.method!=='GET')
    assert.equal(options.headers.authorization,'Bearer ghu_rotated_access');
   return h.fetchFn(url,options);
  };
  const approved=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(approved.status,303);
  assert.equal(pagesReads.length,3);
  for(const request of pagesReads)
   assert.deepEqual(request,{bearer:'Bearer cf_rotated_access',cache:'no-store'});
  const renewals=h.calls.slice(afterPreview).filter(x=>x.method==='POST'&&
   (x.url.endsWith('/oauth/access_token')||x.url.endsWith('/oauth2/token')));
  assert.equal(renewals.length,2);
  assert.notEqual(renewals[0].url,renewals[1].url);
  const total=dbQueries+rateLimitChecks+h.calls.length-afterPreview;
  assert(total<=50,'Both token renewals and approval used '+total+' operations');
 }finally{globalThis.fetch=originalFetch;h.sqlite.close()}
});

test('approval requires same-origin CSRF and a session-bound untampered review receipt',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  let r=await post(h,'/site-update-approve',tenant.cookie,{csrf:'incorrect',ticket});
  assert.equal(r.status,400);
  r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket},
    {headers:{origin:'https://attacker.example'}});
  assert.equal(r.status,400);
  // Mutate an encoded byte, not the final base64url character (which may contain only unused pad bits).
  const tampered=ticket.slice(0,12)+(ticket[12]==='A'?'B':'A')+ticket.slice(13);
  r=await h.request('/site-update-review?ticket='+tampered,{cookie:tenant.cookie});
  assert.equal(r.status,400);
  const second=await connectTenant(h);
  r=await h.request('/site-update-review?ticket='+ticket,{cookie:second.cookie});
  assert.equal(r.status,400,'a different session must not reuse an approval receipt');
  assert.equal(h.resourceState.updateBranch,null);
 }finally{globalThis.fetch=originalFetch}
});

test('a changed GitHub main after preview refuses update and creates no feature branch',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  h.resourceState.headSha='d'.repeat(40);
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(r.status,409);
  assert.equal(h.resourceState.updateBranch,null);
  assert.equal(h.resourceState.updatePr,null);
 }finally{globalThis.fetch=originalFetch}
});

test('repository replacement between reviewed base and approved PR is rejected',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  h.resourceState.repo.id=999;
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(r.status,409);
  assert.equal(h.resourceState.updateBranch,null);
  assert.equal(h.resourceState.updatePr,null);
  assert.equal(h.calls.filter(x=>x.method==='PUT'&&x.url.includes('/contents/')).length,1,
    'only the original launch wrote site contents; update must not write any');
 }finally{globalThis.fetch=originalFetch}
});

test('safe approval replay reuses existing GitHub PR without extra website writes',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  const first=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(first.status,303);
  const second=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(second.status,303);
  assert.equal(h.resourceState.updateFileWrites,1);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/git/refs')).length,1);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/pulls')&&x.method==='POST').length,1);
 }finally{globalThis.fetch=originalFetch}
});

test('GitHub PR permission rejection never merges or edits main and is actionable to customer',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  const mainHtml=h.resourceState.homepageHtml;
  h.resourceState.denyPullRequests=true;
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(r.status,409);
  assert.match(await r.text(),/Pull requests: write/);
  assert.equal(h.resourceState.homepageHtml,mainHtml);
  assert.equal(h.resourceState.updatePr,null);
 }finally{globalThis.fetch=originalFetch}
});

test('expired/changed owner authorization stops approval and update history access',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  h.sqlite.prepare('UPDATE onboarding_sessions SET authorization_epoch=authorization_epoch+1').run();
  assert.equal((await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'})).status,400);
  assert.equal(h.resourceState.updateBranch,null);
  h.sqlite.prepare('UPDATE onboarding_sessions SET expires_at=0').run();
  assert.equal((await h.request('/site-update?id='+tenant.id,{cookie:tenant.cookie})).status,404);
 }finally{globalThis.fetch=originalFetch}
});

test('an unrelated or mismatched private GitHub repo cannot be staged as an update',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h);
  h.resourceState.repo.description='Some other repo';
  const r=await post(h,'/site-update-preview',tenant.cookie,{csrf:tenant.csrf,id:tenant.id,
    tagline:'Should not stage anything'});
  assert.equal(r.status,400);
  assert.equal(h.resourceState.updateBranch,null);
 }finally{globalThis.fetch=originalFetch}
});

test('revocation during a provider response fences subsequent PR writes',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  h.resourceState.invalidateSessionOnRepoRead=true;
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  assert.equal(r.status,409);
  assert.equal(h.resourceState.updateBranch,null);
  assert.equal(h.resourceState.updatePr,null);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/git/refs')).length,0);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/pulls')&&x.method==='POST').length,0);
 }finally{globalThis.fetch=originalFetch}
});

test('status receipts require the same verified owner but survive a reconnect',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),ticket=await reviewedEdit(h,tenant);
  const approved=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'pr'});
  const statusPath=approved.headers.get('location');
  const sameOwner=await connectTenant(h);
  assert.equal((await h.request(statusPath,{cookie:sameOwner.cookie})).status,200);
  h.resourceState.githubUserId=99;
  assert.equal((await h.request(statusPath,{cookie:sameOwner.cookie})).status,400);
 }finally{globalThis.fetch=originalFetch}
});

test('ZIP-imported website never shows a one-page editor link or accepts a manual edit',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h);
  const job=h.sqlite.prepare('SELECT plan_json FROM onboarding_launch_jobs WHERE id=?').get(tenant.id);
  const plan=JSON.parse(job.plan_json);
  delete plan.site;
  plan.zip={id:tenant.id,digest:'a'.repeat(64),fileCount:1,totalBytes:20};
  h.sqlite.prepare('UPDATE onboarding_launch_jobs SET plan_json=? WHERE id=?')
    .run(JSON.stringify(plan),tenant.id);
  const history=await h.request('/history',{cookie:tenant.cookie});
  assert.equal(history.status,200);
  const html=await history.text();
  assert.match(html,/Verified site:/);
  assert.doesNotMatch(html,/Update this website/);
  const editor=await h.request('/site-update?id='+tenant.id,{cookie:tenant.cookie});
  assert.equal(editor.status,404);
  assert.equal(h.resourceState.updateBranch,null);
  assert.equal(h.resourceState.updatePr,null);
 }finally{globalThis.fetch=originalFetch}
});

test('non-editable generated site variants never show an update link',async()=>{
 for(const variant of ['multi-page','forms']){
  const h=harness();globalThis.fetch=h.fetchFn;
  try{
   const tenant=await liveSite(h);
   const record=h.sqlite.prepare('SELECT plan_json FROM onboarding_launch_jobs WHERE id=?').get(tenant.id);
   const plan=JSON.parse(record.plan_json);
   if(variant==='multi-page')plan.site.layout='multi-page';
   if(variant==='forms')plan.forms=true;
   h.sqlite.prepare('UPDATE onboarding_launch_jobs SET plan_json=? WHERE id=?')
     .run(JSON.stringify(plan),tenant.id);
   const history=await h.request('/history',{cookie:tenant.cookie});
   assert.equal(history.status,200);
   assert.doesNotMatch(await history.text(),/Update this website/);
   const editor=await h.request('/site-update?id='+tenant.id,{cookie:tenant.cookie});
   assert.equal(editor.status,404);
   assert.equal(h.resourceState.updateBranch,null);
   assert.equal(h.resourceState.updatePr,null);
  }finally{globalThis.fetch=originalFetch}
 }
});

test('once the form service is set up, a created site\'s update preview adds the built-in contact form',async()=>{
  const h=harness();globalThis.fetch=h.fetchFn;
  try{
    const tenant=await liveSite(h);
    const workerUrl='https://esp-willow-studio-site-form.acct.workers.dev';
    const job=h.sqlite.prepare('SELECT * FROM onboarding_launch_jobs WHERE id=?').get(tenant.id);
    const time=Math.floor(Date.now()/1000);
    h.sqlite.prepare(`INSERT INTO onboarding_option_approvals(id,job_id,github_user_id,cloudflare_account_id,kind,
      approval_digest,payload_json,status,created_at,updated_at) VALUES ('forms-1',?,?,?,'forms',?,'{}','stored',?,?)`)
      .run(tenant.id,job.github_user_id,job.cloudflare_account_id,'b'.repeat(64),time,time);
    h.sqlite.prepare(`INSERT INTO onboarding_forms_provisioning(forms_option_approval_id,job_id,github_user_id,
      cloudflare_account_id,gate_approval_id,widget_sitekey,database_id,schema_applied,worker_deployed,
      worker_subdomain_enabled,worker_schedule_set,worker_url,created_at,updated_at)
      VALUES ('forms-1',?,?,?,'gate_0001','0x4AAAAAAAtestkey','11111111-2222-3333-4444-555555555555',1,1,1,1,?,?,?)`)
      .run(tenant.id,job.github_user_id,job.cloudflare_account_id,workerUrl,time,time);
    const connect=await h.request('/form-connect?id='+tenant.id,{cookie:tenant.cookie});
    assert.equal(connect.status,303);
    assert.equal(connect.headers.get('location'),'/site-update?id='+tenant.id);
    const editor=await (await h.request('/site-update?id='+tenant.id,{cookie:tenant.cookie})).text();
    assert.match(editor,/adds a contact form to the Contact section/);
    const ticket=await reviewedEdit(h,tenant);
    const preview=await (await h.request('/site-update-html?ticket='+encodeURIComponent(ticket),{cookie:tenant.cookie})).text();
    assert.match(preview,/<form class="lo-form" action="https:\/\/esp-willow-studio-site-form\.acct\.workers\.dev\/submit"/);
    assert.match(preview,/data-sitekey="0x4AAAAAAAtestkey"/);
  }finally{globalThis.fetch=originalFetch;h.sqlite.close()}
});

test('Approve and publish merges exactly the approved update PR once, after the preview-policy check (owner decision 2026-11-26)',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h),before=h.resourceState.homepageHtml;
  const ticket=await reviewedEdit(h,tenant);
  const beforeApproval=h.calls.length;
  const approval=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket,action:'publish'});
  assert.equal(approval.status,303,await approval.clone().text());
  assert.equal(h.resourceState.merges.length,1);
  assert.equal(h.resourceState.merges[0].sha,UPDATE_COMMIT,'exactly the approved head');
  assert.equal(h.resourceState.merges[0].merge_method,'squash');
  const approvalCalls=h.calls.slice(beforeApproval);
  const mergeIndex=approvalCalls.findIndex(call=>call.method==='PUT'&&call.url.endsWith('/pulls/55/merge'));
  assert.deepEqual(approvalCalls[mergeIndex-1],{method:'GET',url:PROJECT},'preview-policy check precedes the merge, like every write');
  assert.equal(h.resourceState.homepageHtml,before,'main is never written directly; only the PR merge publishes');
  const statusHtml=await (await h.request(approval.headers.get('location'),{cookie:tenant.cookie})).text();
  assert.doesNotMatch(statusHtml,/Open the change to publish/);
 }finally{globalThis.fetch=originalFetch;}
});

test('approving with no choice publishes; a refused merge leaves the update PR open with an explanation',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const tenant=await liveSite(h);
  const ticket=await reviewedEdit(h,tenant);
  h.resourceState.denyMerge=true;
  const approval=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
  assert.equal(approval.status,303);
  assert.equal(h.resourceState.merges.length,1,'default action publishes');
  const statusHtml=await (await h.request(approval.headers.get('location'),{cookie:tenant.cookie})).text();
  assert.match(statusHtml,/GitHub did not allow an automatic merge/);
  assert.match(statusHtml,/Open the change to publish/);
 }finally{globalThis.fetch=originalFetch;}
});
