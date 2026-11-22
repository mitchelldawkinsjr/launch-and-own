import test from 'node:test';
import assert from 'node:assert/strict';
import {approvePreview,connectTenant,GENERATED_SHA,harness,newPreview,originalFetch,post,csrfFrom} from './worker-test-support.mjs';

const UPDATE_COMMIT='f'.repeat(40);
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
  assert.match(history,/Edit this website \(reviewable GitHub PR\)/);
  const editor=await h.request('/site-update?id='+unfinished,{cookie:tenant.cookie});
  assert.equal(editor.status,200);
  assert.match(await editor.text(),/Original|welcoming place/);
  const ticket=await reviewedEdit(h,{...tenant,id:unfinished});
  const review=await h.request('/site-update-review?ticket='+ticket,{cookie:tenant.cookie});
  assert.equal(review.status,200);
  assert.match(await review.text(),/Approve and create reviewable PR/);
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
  const approval=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
  assert.equal(approval.status,303);
  assert.match(h.resourceState.updateBranch,/^launch-and-own\/site-/);
  assert(h.resourceState.updatePr);
  assert.equal(h.resourceState.homepageHtml,before,'main website must not be directly edited');
  assert.equal(h.resourceState.updateFileWrites,1);
  assert(updateWrites(h).length>beforeWrites);
  const statusPath=approval.headers.get('location');
  let status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.equal(status.status,200);
  assert.match(await status.text(),/awaiting-customer-merge/);
  h.resourceState.updatePr={...h.resourceState.updatePr,state:'closed',
    merged_at:'2026-11-22T19:00:00Z',merge_commit_sha:UPDATE_COMMIT};
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.match(await status.text(),/pending-expected-commit/);
  h.resourceState.pages.canonical_deployment.deployment_trigger.metadata.commit_hash=UPDATE_COMMIT;
  status=await h.request(statusPath,{cookie:tenant.cookie});
  assert.match(await status.text(),/pending-expected-html/);
  h.resourceState.publicHtml=h.resourceState.updateHtml;
  status=await h.request(statusPath,{cookie:tenant.cookie});
  const html=await status.text();
  assert.match(html,/Verified live: exact merged commit and approved HTML SHA-256 match/);
  assert.match(html,/esp-willow-studio-site.pages.dev/);
 }finally{globalThis.fetch=originalFetch}
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
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
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
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
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
  const first=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
  assert.equal(first.status,303);
  const second=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
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
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
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
  assert.equal((await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket})).status,400);
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
  const r=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
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
  const approved=await post(h,'/site-update-approve',tenant.cookie,{csrf:tenant.csrf,ticket});
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
  assert.doesNotMatch(html,/Edit this website/);
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
   assert.doesNotMatch(await history.text(),/Edit this website/);
   const editor=await h.request('/site-update?id='+tenant.id,{cookie:tenant.cookie});
   assert.equal(editor.status,404);
   assert.equal(h.resourceState.updateBranch,null);
   assert.equal(h.resourceState.updatePr,null);
  }finally{globalThis.fetch=originalFetch}
 }
});
>>>>>>> 776757c (Cover unsupported multi-page and form-enabled site editor visibility)
