import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import {accountId, approvePreview, bootstrap, connectCloudflare, csrfFrom, form, GENERATED_SHA, harness,
 jobRow, launchId, makeDue, origin, originalFetch, post, reviewDigest} from './worker-test-support.mjs';

// Node test suite uses one file; each test replaces fetch then restores it.
test('unauthenticated page shows GitHub connect and refuses contact account provisioning',async()=>{
 const h=harness();let res=await h.request('/');assert.equal(res.status,200);assert.match(await res.text(),/Connect GitHub/);
 res=await h.request('/connect/cloudflare');assert.equal(res.status,401);
});
test('realistic OAuth callback login is bound to the preauth cookie and can only be consumed once',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const start=await h.request('/connect/github');const url=new URL(start.headers.get('location'));
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const state=url.searchParams.get('state');
  const wrong=await h.request('/oauth/github/callback?code=good&state='+state,{cookie:'__Host-esp_login='+('f'.repeat(64))});
  assert.equal(wrong.status,400);
  const cookie=start.headers.getSetCookie()[0].split(';')[0];
  const res=await h.request('/oauth/github/callback?code=good&state='+state,{cookie});assert.equal(res.status,303);
  const replay=await h.request('/oauth/github/callback?code=good&state='+state,{cookie});assert.equal(replay.status,400);
  const raw=h.sqlite.prepare('SELECT github_token_ct FROM onboarding_sessions LIMIT 1').get().github_token_ct;
  assert(!raw.includes('ghu_secret_example'),'access token was encrypted');
 }finally{globalThis.fetch=originalFetch}
});
test('customer connects both providers, selects verified account, previews and explicitly approves once',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);
  let home=await h.request('/',{cookie:sessionCookie});let html=await home.text();assert.match(html,/GitHub connected: tester/);assert.match(html,/Connect Cloudflare/);
  await connectCloudflare(h,sessionCookie);
  home=await h.request('/',{cookie:sessionCookie});html=await home.text();assert.match(html,/Demo Account/);
  const csrf=csrfFrom(html);
  const selected=await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});assert.equal(selected.status,303);
  home=await h.request('/',{cookie:sessionCookie});html=await home.text();assert.match(html,/Preview my website/);
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});assert.equal(pre.status,303);
  const reviewUrl=pre.headers.get('location');assert.match(reviewUrl,/^\/review\?id=/);
  const review=await h.request(reviewUrl,{cookie:sessionCookie});assert.equal(review.status,200);assert.match(await review.text(),/Approve and create website/);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'preview');
  const launchId=new URL('https://onboard.example.com'+reviewUrl).searchParams.get('id');
  const digest=await reviewDigest(h,sessionCookie,launchId);
  const approved=await post(h,'/approve',sessionCookie,{csrf,id:launchId,digest});assert.equal(approved.status,303);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(h.sqlite.prepare('SELECT count(*) AS c FROM onboarding_launches').get().c,1);
  assert.equal(h.calls.some(x=>x.url.includes('pages/projects')),true);
  assert.equal(h.resourceState.repo.description,'Launch & Own managed site: willow-studio [job:'+launchId+']');
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
  const verified=await h.request('/verify',{method:'POST',cookie:sessionCookie,body:form({csrf,id:launchId})});assert.equal(verified.status,303);
  assert.equal(jobRow(h).status,'live');
  const again=await post(h,'/approve',sessionCookie,{csrf,id:launchId,digest});assert.equal(again.status,400);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS c FROM onboarding_launches').get().c,1);
  const ct=h.sqlite.prepare('SELECT cloudflare_token_ct FROM onboarding_sessions').get().cloudflare_token_ct;
  assert(!ct.includes('cf_secret_example'),'Cloudflare token encrypted');
 }finally{globalThis.fetch=originalFetch}
});
test('CSRF mismatch and wrong origin cannot select accounts or approve a website',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const invalid=await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf:'incorrect',accountId})});assert.equal(invalid.status,400);
  const noOrigin=await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf:'whatever',accountId}),headers:{origin:'https://evil.example'}});assert.equal(noOrigin.status,400);
  assert.equal(h.sqlite.prepare('SELECT cloudflare_account_id FROM onboarding_sessions').get().cloudflare_account_id,null);
 }finally{globalThis.fetch=originalFetch}
});
test('cross-session launch records are not accessible to a different connected user session',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const one=await bootstrap(h);await connectCloudflare(h,one.sessionCookie);
  let html=await (await h.request('/',{cookie:one.sessionCookie})).text();const csrf=csrfFrom(html);
  await h.request('/account',{method:'POST',cookie:one.sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:one.sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const two=await bootstrap(h);
  const review=await h.request(p.headers.get('location'),{cookie:two.sessionCookie});assert.equal(review.status,404);
  const id=new URL('https://onboard.example.com'+p.headers.get('location')).searchParams.get('id');
  const twohtml=await (await h.request('/',{cookie:two.sessionCookie})).text();const csrf2=csrfFrom(twohtml);
  const approve=await h.request('/approve',{method:'POST',cookie:two.sessionCookie,body:form({csrf:csrf2,id})});assert.equal(approve.status,400);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'preview');
 }finally{globalThis.fetch=originalFetch}
});
test('health endpoint never exposes credentials; no public session leak',async()=>{
 const h=harness();const result=await (await h.request('/health')).json();assert.deepEqual(result,{ok:true,configured:true,launchJobsReady:true});
 assert(!JSON.stringify(result).includes(h.env.TOKEN_ENCRYPTION_KEY));
});

test('transient provisioning failure preserves the pinned repo and retries only when due',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL('https://onboard.example.com'+p.headers.get('location')).searchParams.get('id');
  h.resourceState.failPagesOnce=true;
  let r=await approvePreview(h,sessionCookie,csrf,id);assert.equal(r.status,303);
  assert.equal(jobRow(h).status,'queued');
  assert.equal(jobRow(h).error_code,'provider_unavailable');
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
  assert(h.resourceState.repo&&h.resourceState.homepage);assert.equal(h.resourceState.pages,null);
  await post(h,'/launch',sessionCookie,{csrf,id});
  assert.equal(h.resourceState.pages,null);
  assert.equal(jobRow(h).attempts,1);
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert.equal(h.calls.filter(x=>x.url==='https://api.github.com/user/repos').length,1);
 }finally{globalThis.fetch=originalFetch}
});
test('logout deletes encrypted session credentials and prevents further account access',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  const r=await h.request('/logout',{method:'POST',cookie:sessionCookie,body:form({csrf})});assert.equal(r.status,303);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS c FROM onboarding_sessions').get().c,0);
  const home=await h.request('/',{cookie:sessionCookie});assert.match(await home.text(),/Connect GitHub/);
 }finally{globalThis.fetch=originalFetch}
});
test('scheduled maintenance removes expired flow and session records',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);
  const hash=h.sqlite.prepare('SELECT id_hash FROM onboarding_sessions').get().id_hash;
  h.sqlite.prepare('UPDATE onboarding_sessions SET expires_at=0 WHERE id_hash=?').run(hash);
  h.sqlite.prepare("INSERT INTO onboarding_flows(state_hash,provider,binding_hash,verifier_ct,expires_at) VALUES(?,?,?,?,?)").run('garbage','github','binding','cipher',0);
  await worker.scheduled({cron:'0 3 * * *'},h.env);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS c FROM onboarding_flows WHERE state_hash=\'garbage\'').get().c,0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS c FROM onboarding_sessions').get().c,0);
 }finally{globalThis.fetch=originalFetch}
});
test('rate limiter rejects GitHub connection before writing temporary OAuth state',async()=>{
 const h=harness();h.env.ONBOARDING_LIMITER={limit:async()=>({success:false})};
 const r=await h.request('/connect/github');assert.equal(r.status,400);
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS c FROM onboarding_flows').get().c,0);
});

test('health does not claim readiness if an OAuth secret is missing',async()=>{
 const h=harness();delete h.env.CF_CLIENT_SECRET;
 const response=await h.request('/health');
 assert.deepEqual(await response.json(),{ok:true,configured:false,launchJobsReady:true});
});
test('browser session cookies use secure host-only flags',async()=>{
 const h=harness();
 const response=await h.request('/connect/github');
 assert.equal(response.status,303);
 const cookieValue=response.headers.getSetCookie().find(c=>c.startsWith('__Host-esp_login='));
 assert.match(cookieValue,/Secure/);
 assert.match(cookieValue,/HttpOnly/);
 assert.match(cookieValue,/SameSite=Lax/);
 assert.match(cookieValue,/Path=\//);
});
test('customer-controlled site names are escaped on review page',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const response=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'<img src=x onerror=alert(1)>'})});
  assert.equal(response.status,303);
  const review=await h.request(response.headers.get('location'),{cookie:sessionCookie});
  const html=await review.text();
  assert(!html.includes('<img src=x onerror=alert(1)>'));
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 }finally{globalThis.fetch=originalFetch}
});

test('stale successful Pages revision never marks a newly provisioned customer site live',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+pre.headers.get('location')).searchParams.get('id');
  await approvePreview(h,sessionCookie,csrf,id);
  h.resourceState.pages.canonical_deployment.deployment_trigger.metadata.commit_hash='b'.repeat(40);
  const result=await h.request('/verify',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});
  assert.equal(result.status,303);
  assert.equal(jobRow(h).status,'pending_deployment');
 }finally{globalThis.fetch=originalFetch}
});
test('job schema rejects a pending deployment without a pinned revision',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+pre.headers.get('location')).searchParams.get('id');
  await approvePreview(h,sessionCookie,csrf,id);
  assert.throws(()=>h.sqlite.prepare(`UPDATE onboarding_launch_jobs
    SET expected_commit_sha=NULL, repository_id=NULL, production_branch=NULL`).run(),/CHECK constraint/);
  assert.equal(jobRow(h).status,'pending_deployment');
 }finally{globalThis.fetch=originalFetch}
});

test('product onboarding shows Launch & Own identity and customer ownership tagline',async()=>{
 const h=harness();
 const result=await h.request('/');
 const html=await result.text();
 assert.match(html,/Launch & Own/);
 assert.match(html,/Describe it\. Launch it\. Own it\./);
});


test('disconnect revokes GitHub grant and Cloudflare OAuth token and removes the local session',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  const result=await h.request('/logout',{method:'POST',cookie:sessionCookie,body:form({csrf})});
  assert.equal(result.status,303);
  assert.equal(result.headers.get('location'),'/?disconnect=complete');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM onboarding_sessions').get().count,0);
  assert(h.calls.some(c=>c.url==='https://api.github.com/applications/Iv1.example/grant'&&c.method==='DELETE'));
  assert(h.calls.some(c=>c.url==='https://dash.cloudflare.com/oauth2/revoke'&&c.method==='POST'));
  const notice=await (await h.request('/?disconnect=complete')).text();
  assert.match(notice,/Launch &amp; Own access was removed/);
  const old=await (await h.request('/',{cookie:sessionCookie})).text();
  assert.match(old,/Connect GitHub/);
 }finally{globalThis.fetch=originalFetch}
});
test('a remote revocation failure still signs out locally and displays an honest warning',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  h.resourceState.failGitHubRevokeOnce=true;
  const result=await h.request('/logout',{method:'POST',cookie:sessionCookie,body:form({csrf})});
  assert.equal(result.status,303);
  assert.equal(result.headers.get('location'),'/?disconnect=unconfirmed');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM onboarding_sessions').get().count,0);
  const msg=await (await h.request('/?disconnect=unconfirmed')).text();
  assert.match(msg,/may still show Launch &amp; Own as connected/);
  assert(!msg.includes('ghu_secret_example'));
 }finally{globalThis.fetch=originalFetch}
});

test('OAuth callback stores encrypted refresh tokens and renews both providers before an approved launch',async()=>{
 const h=harness();h.resourceState.issueExpiringGrants=true;globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);
  const first=h.sqlite.prepare('SELECT * FROM onboarding_sessions').get();
  assert(first.github_refresh_token_ct&&!first.github_refresh_token_ct.includes('ghr_initial'));
  await connectCloudflare(h,sessionCookie);
  const record=h.sqlite.prepare('SELECT * FROM onboarding_sessions').get();
  assert(record.cloudflare_refresh_token_ct&&!record.cloudflare_refresh_token_ct.includes('cf_initial_refresh'));
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  h.sqlite.prepare('UPDATE onboarding_sessions SET github_token_expires_at=1,cloudflare_token_expires_at=1').run();
  const selected=await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  assert.equal(selected.status,303);
  const p=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  const approved=await approvePreview(h,sessionCookie,csrf,id);
  assert.equal(approved.status,303);
  assert.equal(jobRow(h).status,'pending_deployment');
  const updated=h.sqlite.prepare('SELECT * FROM onboarding_sessions').get();
  assert(updated.github_refresh_token_ct!==first.github_refresh_token_ct);
  assert(updated.cloudflare_refresh_token_ct!==record.cloudflare_refresh_token_ct);
  assert(h.calls.filter(c=>c.url==='https://github.com/login/oauth/access_token').length>=2);
  assert(h.calls.filter(c=>c.url==='https://dash.cloudflare.com/oauth2/token').length>=2);
 }finally{globalThis.fetch=originalFetch}
});
test('expired GitHub refresh grant prevents launch without changing customer resources',async()=>{
 const h=harness();h.resourceState.issueExpiringGrants=true;globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  h.sqlite.prepare('UPDATE onboarding_sessions SET github_token_expires_at=1, github_refresh_expires_at=1').run();
  await approvePreview(h,sessionCookie,csrf,id);
  assert.equal(jobRow(h).status,'needs_reauthorization');
  assert.equal(h.resourceState.repo,null);
  assert(!h.calls.some(c=>c.url==='https://api.github.com/user/repos'));
 }finally{globalThis.fetch=originalFetch}
});


test('scheduled recovery resumes a previously approved but interrupted website launch without creating duplicate repos',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+pre.headers.get('location')).searchParams.get('id');
  await approvePreview(h,sessionCookie,csrf,id,{skipFastPath:true});
  // An interrupted process held this lease and did not record an outcome.
  h.sqlite.prepare("UPDATE onboarding_launch_jobs SET lease_id='interrupted',lease_until=1,attempts=1 WHERE id=?").run(id);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'pending_deployment');
  assert(h.resourceState.repo&&h.resourceState.pages);
  assert.equal(h.calls.filter(x=>x.url==='https://api.github.com/user/repos').length,1);
  // Another scheduled run cannot repeat provisioning because its status changed.
  await worker.scheduled({},h.env);
  assert.equal(h.calls.filter(x=>x.url==='https://api.github.com/user/repos').length,1);
 }finally{globalThis.fetch=originalFetch}
});
test('scheduled recovery promotes only verified, exact-commit production deploys to live',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+pre.headers.get('location')).searchParams.get('id');
  await approvePreview(h,sessionCookie,csrf,id);
  h.resourceState.pages.canonical_deployment.deployment_trigger.metadata.commit_hash='b'.repeat(40);
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'pending_deployment');
  h.resourceState.pages.canonical_deployment.deployment_trigger.metadata.commit_hash=GENERATED_SHA;
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'live');
 }finally{globalThis.fetch=originalFetch}
});
test('scheduled recovery never creates resources for preview-only or expired-session launch records',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await post(h,'/preview',sessionCookie,{csrf,name:'Willow Studio'});
  h.sqlite.prepare('UPDATE onboarding_launches SET updated_at=1').run();
  await worker.scheduled({},h.env);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'preview');
  await approvePreview(h,sessionCookie,csrf,launchId(pre),{skipFastPath:true});
  h.sqlite.prepare('UPDATE onboarding_sessions SET expires_at=1').run();
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'needs_reauthorization');
  assert.equal(h.resourceState.repo,null);
  assert(!h.calls.some(x=>x.url==='https://api.github.com/user/repos'));
 }finally{globalThis.fetch=originalFetch}
});
test('scheduled recovery does not retry failed jobs until a customer explicitly retries',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+pre.headers.get('location')).searchParams.get('id');
  h.resourceState.pagesError=422;
  await approvePreview(h,sessionCookie,csrf,id);
  assert.equal(jobRow(h).status,'failed');
  makeDue(h);
  await worker.scheduled({},h.env);
  assert.equal(jobRow(h).status,'failed');
  assert.equal(h.resourceState.pages,null);
 }finally{globalThis.fetch=originalFetch}
});


test('site preview shows exactly the approved copy, and deployed HTML matches it',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const req=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio',
   tagline:"Moments worth remembering",about:"Family portraits with thoughtful details",
   services:"Portraits\nEvents",theme:"sunset",contactEmail:"hello@willow.example"})});
  assert.equal(req.status,303);
  const id=new URL(origin+req.headers.get('location')).searchParams.get('id');
  const page=await h.request('/site-preview?id='+id,{cookie:sessionCookie});
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);
  assert.match(page.headers.get('cache-control'),/no-store/);
  const html=await page.text();
  assert.match(html,/Moments worth remembering/);
  assert.match(html,/Family portraits/);
  assert.match(html,/Portraits/);
  assert.match(html,/--accent:#994936/);
  const review=await (await h.request('/review?id='+id,{cookie:sessionCookie})).text();
  assert.match(review,/Open the exact preview/);
  const approved=await approvePreview(h,sessionCookie,csrf,id);
  assert.equal(approved.status,303);
  assert.equal(h.resourceState.homepageHtml,html);
  assert.equal(jobRow(h).status,'pending_deployment');
 }finally{globalThis.fetch=originalFetch}
});
test('a different signed-in customer cannot open the private website preview',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const first=await bootstrap(h);await connectCloudflare(h,first.sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:first.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:first.sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:first.sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  const second=await bootstrap(h);
  const denied=await h.request('/site-preview?id='+id,{cookie:second.sessionCookie});
  assert.equal(denied.status,404);
  assert(!((await denied.text()).includes('Willow Studio')));
 }finally{globalThis.fetch=originalFetch}
});
test('unsafe color/theme configuration cannot create launch records or provider resources',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const invalid=await h.request('/preview',{method:'POST',cookie:sessionCookie,
    body:form({csrf,name:'Willow Studio',theme:'javascript:alert(1)'})});
  assert.equal(invalid.status,400);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS c FROM onboarding_launches').get().c,0);
  assert.equal(h.resourceState.repo,null);
 }finally{globalThis.fetch=originalFetch}
});


test('approved job survives logout and reapproval resumes the same pinned deployment',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const first=await bootstrap(h);await connectCloudflare(h,first.sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:first.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:first.sessionCookie,body:form({csrf,accountId})});
  const initial=await h.request('/preview',{method:'POST',cookie:first.sessionCookie,body:form({csrf,name:'Willow Studio',
    tagline:'An original customer design',theme:'forest',services:'Portraits'})});
  const id=new URL(origin+initial.headers.get('location')).searchParams.get('id');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_jobs').get().n,0,'Unapproved previews are not durable');
  await approvePreview(h,first.sessionCookie,csrf,id);
  const receipt=jobRow(h);
  assert.equal(receipt.id,id);assert.equal(receipt.github_user_id,42);
  assert.equal(receipt.status,'pending_deployment');
  const encoded=JSON.stringify(receipt);
  for(const secret of ['ghu_secret_example','cf_secret_example','ghr_initial','TOKEN_ENCRYPTION_KEY','session_hash']){
   assert(!encoded.includes(secret),'Receipt contained sensitive token/session data');
  }
  const count=h.calls.filter(x=>x.url==='https://api.github.com/user/repos').length;
  const logout=await h.request('/logout',{method:'POST',cookie:first.sessionCookie,body:form({csrf})});
  assert.equal(logout.status,303);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_sessions').get().n,0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_launches').get().n,0,'Session-owned launch rows cascade');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_jobs').get().n,1,'Approved history survives logout');
  const anonymous=await h.request('/history');assert.equal(anonymous.status,401);
  const second=await bootstrap(h);await connectCloudflare(h,second.sessionCookie);
  const csrf2=csrfFrom(await (await h.request('/',{cookie:second.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:second.sessionCookie,body:form({csrf:csrf2,accountId})});
  const history=await (await h.request('/history',{cookie:second.sessionCookie})).text();
  assert.match(history,/Willow Studio/);assert.match(history,/Review and continue/);
  const restored=await h.request('/restore',{method:'POST',cookie:second.sessionCookie,body:form({csrf:csrf2,id})});
  assert.equal(restored.status,303);
  const newId=new URL(origin+restored.headers.get('location')).searchParams.get('id');
  assert.notEqual(newId,id);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'preview');
  const html=await (await h.request('/site-preview?id='+newId,{cookie:second.sessionCookie})).text();
  assert.match(html,/An original customer design/);
  assert.equal(h.calls.filter(x=>x.url==='https://api.github.com/user/repos').length,count,'Restore did not mutate providers');
  await approvePreview(h,second.sessionCookie,csrf2,newId);
  assert.equal(jobRow(h).status,'live');
  assert.equal(jobRow(h).id,id);
  assert.equal(jobRow(h).expires_at,receipt.expires_at);
  assert.equal(jobRow(h).expected_commit_sha,GENERATED_SHA);
  assert.equal(h.calls.filter(x=>x.url==='https://api.github.com/user/repos').length,count,'Safe repeat reused private repository');
 }finally{globalThis.fetch=originalFetch}
});
test('another GitHub identity cannot read or restore an approved customer launch',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const one=await bootstrap(h);await connectCloudflare(h,one.sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:one.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:one.sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:one.sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  await approvePreview(h,one.sessionCookie,csrf,id);
  h.resourceState.githubUserId=9999;
  const other=await bootstrap(h);await connectCloudflare(h,other.sessionCookie);
  const otherCsrf=csrfFrom(await (await h.request('/',{cookie:other.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:other.sessionCookie,body:form({csrf:otherCsrf,accountId})});
  const history=await (await h.request('/history',{cookie:other.sessionCookie})).text();
  assert(!history.includes('Willow Studio'));
  const denied=await h.request('/restore',{method:'POST',cookie:other.sessionCookie,body:form({csrf:otherCsrf,id})});
  assert.equal(denied.status,400);
 }finally{globalThis.fetch=originalFetch}
});
test('reconnect must select the same verified Cloudflare account for history access',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const one=await bootstrap(h);await connectCloudflare(h,one.sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:one.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:one.sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:one.sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  await approvePreview(h,one.sessionCookie,csrf,id);
  const second=await bootstrap(h);await connectCloudflare(h,second.sessionCookie);
  const secondRaw=second.sessionCookie.split('=')[1];
  const secondHash=await (await import('./crypto.mjs')).sha256(secondRaw);
  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_account_id=? WHERE id_hash=?').run('f'.repeat(32),secondHash);
  const secondCsrf=csrfFrom(await (await h.request('/',{cookie:second.sessionCookie})).text());
  const history=await (await h.request('/history',{cookie:second.sessionCookie})).text();
  assert(!history.includes('Willow Studio'));
  const denied=await h.request('/restore',{method:'POST',cookie:second.sessionCookie,body:form({csrf:secondCsrf,id})});
  assert.equal(denied.status,400);
 }finally{globalThis.fetch=originalFetch}
});
test('an active approved launch is not duplicated by premature restoration',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const first=await bootstrap(h);await connectCloudflare(h,first.sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:first.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:first.sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:first.sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  await approvePreview(h,first.sessionCookie,csrf,id);
  const other=await bootstrap(h);await connectCloudflare(h,other.sessionCookie);
  const csrf2=csrfFrom(await (await h.request('/',{cookie:other.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:other.sessionCookie,body:form({csrf:csrf2,accountId})});
  const denied=await h.request('/restore',{method:'POST',cookie:other.sessionCookie,body:form({csrf:csrf2,id})});
  assert.equal(denied.status,400);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_launches').get().n,1);
 }finally{globalThis.fetch=originalFetch}
});
test('receipt retention is bounded and expired receipts are purged on scheduled maintenance',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const one=await bootstrap(h);await connectCloudflare(h,one.sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:one.sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:one.sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:one.sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+p.headers.get('location')).searchParams.get('id');
  await approvePreview(h,one.sessionCookie,csrf,id);
  h.sqlite.prepare('UPDATE onboarding_launch_jobs SET expires_at=1').run();
  await worker.scheduled({},h.env);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_jobs').get().n,0);
 }finally{globalThis.fetch=originalFetch}
});


test("AI drafting is invisible until operator configures optional model binding",async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request("/",{cookie:sessionCookie})).text());
  await h.request("/account",{method:"POST",cookie:sessionCookie,body:form({csrf,accountId})});
  const page=await (await h.request("/",{cookie:sessionCookie})).text();
  assert(!page.includes("Draft my website copy"));
  assert.match(page,/Preview my website/);
  const disabled=await h.request("/draft",{method:"POST",cookie:sessionCookie,body:form({
    csrf,name:"Willow Studio",description:"Photography services for local families and community events."
  })});
  assert.equal(disabled.status,503);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM onboarding_launches").get().n,0);
 }finally{globalThis.fetch=originalFetch}
});
test("AI draft is user initiated, editable, private and requires a separate preview/approval",async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 const description="Willow Studio provides local family portrait sessions and photography for neighborhood events.";
 let modelCalls=0;
 h.env.SITE_AI_MODEL="@cf/meta/llama-3.1-8b-instruct";
 h.env.AI={run:async(model,req)=>{
   modelCalls++;
   assert.equal(model,h.env.SITE_AI_MODEL);
   assert.match(req.messages[1].content,/Willow Studio/);
   assert(!JSON.stringify(req).includes("hello@willow.example"),"Customer email not passed to model");
   return {response:JSON.stringify({tagline:"Your memories matter",about:"Family portraits and community event photography.",
     services:["Family portraits","Community events"],contactEmail:"malicious@example.com"})};
 }};
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request("/",{cookie:sessionCookie})).text());
  await h.request("/account",{method:"POST",cookie:sessionCookie,body:form({csrf,accountId})});
  const page=await (await h.request("/",{cookie:sessionCookie})).text();
  assert.match(page,/Draft my website copy/);
  assert.equal(modelCalls,0,"GET homepage must never call an AI model");
  const draft=await h.request("/draft",{method:"POST",cookie:sessionCookie,
    body:form({csrf,name:"Willow Studio",description,theme:"sunset",contactEmail:"hello@willow.example"})});
  assert.equal(draft.status,200);
  const html=await draft.text();
  assert.match(html,/Your memories matter/);
  assert.match(html,/Family portraits/);
  assert.match(html,/Review your AI-assisted draft/);
  assert.match(html,/Preview this edited draft/);
  assert.match(html,/value="hello@willow.example"/);
  assert(!html.includes("malicious@example.com"));
  assert.equal(modelCalls,1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM onboarding_launches").get().n,0,
    "Unreviewed AI drafts must not create launch plans");
  assert.equal(h.resourceState.repo,null);
  const preview=await h.request("/preview",{method:"POST",cookie:sessionCookie,body:form({
    csrf,name:"Willow Studio",tagline:"Your memories matter",about:"Family portraits and community event photography.",
    services:"Family portraits\nCommunity events",theme:"sunset",contactEmail:"hello@willow.example"
  })});
  assert.equal(preview.status,303);
  const id=new URL(origin+preview.headers.get("location")).searchParams.get("id");
  const site=await (await h.request("/site-preview?id="+id,{cookie:sessionCookie})).text();
  assert.match(site,/Your memories matter/);
  assert.equal(modelCalls,1,"Regular preview must not trigger a second paid model call");
  assert.equal(h.resourceState.repo,null,"Public repo must not be created until explicit approval");
 }finally{globalThis.fetch=originalFetch}
});
test("AI draft endpoint is CSRF protected and requires selected provider account",async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 let calls=0;
 h.env.AI={run:async()=>{calls++;return {response:{tagline:"Title",about:"About",services:[]}}}};
 h.env.SITE_AI_MODEL="@cf/meta/llama-3.1-8b-instruct";
 try{
  const unauth=await h.request("/draft",{method:"POST",body:form({csrf:"fake",name:"Studio",
    description:"A community photo studio offering portraits and event coverage."})});
  assert.equal(unauth.status,400);
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request("/",{cookie:sessionCookie})).text());
  const noAccount=await h.request("/draft",{method:"POST",cookie:sessionCookie,
    body:form({csrf,name:"Studio",description:"A community photo studio offering portraits and event coverage."})});
  assert.equal(noAccount.status,400);
  await h.request("/account",{method:"POST",cookie:sessionCookie,body:form({csrf,accountId})});
  const badCsrf=await h.request("/draft",{method:"POST",cookie:sessionCookie,
    body:form({csrf:"wrong",name:"Studio",description:"A community photo studio offering portraits and event coverage."})});
  assert.equal(badCsrf.status,400);
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch}
});
test("AI provider failure never reveals provider error or stores an unapproved plan",async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 h.env.SITE_AI_MODEL="@cf/meta/llama-3.1-8b-instruct";
 h.env.AI={run:async()=>{throw Error("provider token secret in external error")}};
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request("/",{cookie:sessionCookie})).text());
  await h.request("/account",{method:"POST",cookie:sessionCookie,body:form({csrf,accountId})});
  const result=await h.request("/draft",{method:"POST",cookie:sessionCookie,
    body:form({csrf,name:"Willow Studio",description:"Local family photography and community event services."})});
  assert.equal(result.status,502);
  const html=await result.text();
  assert.match(html,/manual website editor/);
  assert(!html.includes("provider token secret"));
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM onboarding_launches").get().n,0);
 }finally{globalThis.fetch=originalFetch}
});

test('form pages use a referrer policy that keeps the same-origin Origin header on POSTs',async()=>{
 // Browsers send `Origin: null` for form POSTs under no-referrer, which assertCsrf rejects.
 const h=harness();const res=await h.request('/');
 assert.equal(res.headers.get('referrer-policy'),'same-origin');
});

test('privacy and terms pages are public and linked from every page footer',async()=>{
 const h=harness();
 for(const [path,title] of [['/privacy','Privacy Policy'],['/terms','Terms of Service']]){
  const res=await h.request(path);assert.equal(res.status,200);
  const html=await res.text();assert.match(html,new RegExp('<h1>'+title+'</h1>'));assert.match(html,/Last updated/);
 }
 const home=await (await h.request('/')).text();
 assert.match(home,/href="\/privacy"/);assert.match(home,/href="\/terms"/);
});

test('logo is served publicly as a PNG for the provider consent screens',async()=>{
 const h=harness();const res=await h.request('/logo.png');
 assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/png');
 const bytes=new Uint8Array(await res.arrayBuffer());
 assert.deepEqual([...bytes.slice(0,4)],[0x89,0x50,0x4e,0x47]);
});

test('pressing Run due launch steps after the job already advanced shows the review page, not an error',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL('https://onboard.example.com'+p.headers.get('location')).searchParams.get('id');
  await approvePreview(h,sessionCookie,csrf,id);
  assert.notEqual(jobRow(h).status,'queued');
  const attempts=jobRow(h).attempts;
  const r=await post(h,'/launch',sessionCookie,{csrf,id});
  assert.equal(r.status,303);assert.match(r.headers.get('location'),/^\/review\?id=/);
  assert.equal(jobRow(h).attempts,attempts);
  // A different session (not the one that approved) is still refused.
  const other=await bootstrap(h);
  const o=await post(h,'/launch',other.sessionCookie,{csrf:csrfFrom(await (await h.request('/',{cookie:other.sessionCookie})).text()),id});
  assert.notEqual(o.status,303);
 }finally{globalThis.fetch=originalFetch}
});
