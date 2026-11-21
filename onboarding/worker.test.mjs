import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from './worker.mjs';
const origin='https://onboard.example.com';
const accountId='0123456789abcdef0123456789abcdef';
const GENERATED_SHA='a'.repeat(40);
function harness(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('PRAGMA foreign_keys = ON');
 sqlite.exec(readFileSync(new URL('./migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...args){return {first:async()=>sqlite.prepare(sql).get(...args)||null,run:async()=>sqlite.prepare(sql).run(...args),all:async()=>({results:sqlite.prepare(sql).all(...args)})}}}},batch:async(stmts)=>Promise.all(stmts.map(s=>s.run()))};
 const env={DB,ONBOARDING_LIMITER:{limit:async()=>({success:true})},ONBOARDING_ORIGIN:origin,TOKEN_ENCRYPTION_KEY:'abababababababababababababababababababababababababababababababab',GH_CLIENT_ID:'Iv1.example',GH_CLIENT_SECRET:'dummy-gh-secret',CF_CLIENT_ID:'cf-client-id',CF_CLIENT_SECRET:'dummy-cf-secret',CF_SCOPES:'workers-platform.read workers-platform.write'};
 const calls=[];
 const resourceState={repo:null,homepage:false,pages:null,failPagesOnce:false};
 const fetchFn=async(url,opts={})=>{
  calls.push({url,method:opts.method||'GET'});
  if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'ghu_secret_example',token_type:'bearer'});
  if(url==='https://api.github.com/user')return Response.json({login:'tester',id:42});
  if(url==='https://dash.cloudflare.com/oauth2/token')return Response.json({access_token:'cf_secret_example',token_type:'bearer'});
  if(url.includes('/accounts?page=1'))return Response.json({success:true,result:[{id:accountId,name:'Demo Account'}]});
  if(url.endsWith('/accounts/'+accountId))return Response.json({success:true,result:{id:accountId,name:'Demo Account'}});
  const root='https://api.github.com/repos/tester/esp-willow-studio';
  const pages='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/pages/projects';
  if(url===root && opts.method!=='POST')return resourceState.repo?Response.json(resourceState.repo):new Response('{}',{status:404});
  if(url==='https://api.github.com/user/repos' && opts.method==='POST'){
    resourceState.repo={id:101,owner:{login:'tester'},name:'esp-willow-studio',description:JSON.parse(opts.body).description,private:true,default_branch:'main'};
    return Response.json(resourceState.repo,{status:201});
  }
  if(url===root+'/branches/main')return Response.json({commit:{sha:GENERATED_SHA}});
  if(url===root+'/contents/public/index.html'){
    if(opts.method==='PUT'){resourceState.homepage=true;return Response.json({content:{sha:'abc'}},{status:201})}
    return resourceState.homepage?Response.json({type:'file',sha:'abc'}):new Response('{}',{status:404});
  }
  if(url===pages+'/esp-willow-studio-site')return resourceState.pages?Response.json({success:true,result:resourceState.pages}):new Response('{}',{status:404});
  if(url===pages && opts.method==='POST'){
    if(resourceState.failPagesOnce){resourceState.failPagesOnce=false;return Response.json({success:false},{status:503})}
    resourceState.pages={name:'esp-willow-studio-site',production_branch:'main',source:{type:'github',config:{owner:'tester',repo_name:'esp-willow-studio',repo_id:'101'}},canonical_deployment:{id:'deploy-success',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{commit_hash:GENERATED_SHA}}}};
    return Response.json({success:true,result:resourceState.pages},{status:201});
  }
  if(url==='https://esp-willow-studio-site.pages.dev/')return new Response('<html>Willow Studio</html>',{status:200,headers:{'content-type':'text/html'}});
  throw Error('unmocked external request: '+url);
 };
 const request=async(path,opts={})=>worker.fetch(new Request(origin+path,{method:opts.method||'GET',headers:{...(opts.cookie?{cookie:opts.cookie}:{}),...(opts.method==='POST'?{'content-type':'application/x-www-form-urlencoded',origin}:{}),...opts.headers},body:opts.body} ),env);
 return {sqlite,env,DB,request,fetchFn,calls,resourceState};
}
async function bootstrap(h){
 const gh=await h.request('/connect/github');assert.equal(gh.status,303);
 const loginCookie=gh.headers.getSetCookie().find(x=>x.startsWith('__Host-esp_login=' )).split(';')[0];
 const state=new URL(gh.headers.get('location')).searchParams.get('state');
 const callback=await h.request('/oauth/github/callback?code=good&state='+state,{cookie:loginCookie});
 assert.equal(callback.status,303);
 const sessionCookie=callback.headers.getSetCookie().find(x=>x.startsWith('__Host-esp_session=')).split(';')[0];
 return {loginCookie,state,sessionCookie};
}
async function connectCloudflare(h,sessionCookie){
 const start=await h.request('/connect/cloudflare',{cookie:sessionCookie});assert.equal(start.status,303);
 const state=new URL(start.headers.get('location')).searchParams.get('state');
 const cb=await h.request('/oauth/cloudflare/callback?code=valid&state='+state,{cookie:sessionCookie});assert.equal(cb.status,303);
 return state;
}
function csrfFrom(html){const x=html.match(/name="csrf" value="([a-f0-9]+)"/);assert(x,'CSRF hidden input');return x[1]}
const form=(values)=>new URLSearchParams(values).toString();
const originalFetch=globalThis.fetch;
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
  home=await h.request('/',{cookie:sessionCookie});html=await home.text();assert.match(html,/Review setup/);
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});assert.equal(pre.status,303);
  const reviewUrl=pre.headers.get('location');assert.match(reviewUrl,/^\/review\?id=/);
  const review=await h.request(reviewUrl,{cookie:sessionCookie});assert.equal(review.status,200);assert.match(await review.text(),/Approve and create website/);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'preview');
  const launchId=new URL('https://onboard.example.com'+reviewUrl).searchParams.get('id');
  const approved=await h.request('/approve',{method:'POST',cookie:sessionCookie,body:form({csrf,id:launchId})});assert.equal(approved.status,303);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'pending_deployment');
  assert.equal(h.sqlite.prepare('SELECT count(*) AS c FROM onboarding_launches').get().c,1);
  assert.equal(h.calls.some(x=>x.url.includes('pages/projects')),true);
  assert.equal(h.resourceState.repo.description,'Launch & Own managed site: willow-studio');
  const resultJson=JSON.parse(h.sqlite.prepare('SELECT provision_result FROM onboarding_launches').get().provision_result);
  assert.equal(resultJson.headCommitSha,GENERATED_SHA);
  const verified=await h.request('/verify',{method:'POST',cookie:sessionCookie,body:form({csrf,id:launchId})});assert.equal(verified.status,303);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'live');
  const again=await h.request('/approve',{method:'POST',cookie:sessionCookie,body:form({csrf,id:launchId})});assert.equal(again.status,400);
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
 const h=harness();const result=await (await h.request('/health')).json();assert.deepEqual(result,{ok:true,configured:true});
 assert(!JSON.stringify(result).includes(h.env.TOKEN_ENCRYPTION_KEY));
});

test('failed provisioning preserves private repo, displays retry, and succeeds idempotently on retry',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const p=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL('https://onboard.example.com'+p.headers.get('location')).searchParams.get('id');
  h.resourceState.failPagesOnce=true;
  let r=await h.request('/approve',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});assert.equal(r.status,303);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'failed');
  assert(h.resourceState.repo&&h.resourceState.homepage);assert.equal(h.resourceState.pages,null);
  r=await h.request('/review?id='+id,{cookie:sessionCookie});assert.match(await r.text(),/Retry provisioning safely/);
  r=await h.request('/launch',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});assert.equal(r.status,303);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'pending_deployment');
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
 assert.deepEqual(await response.json(),{ok:true,configured:false});
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
  await h.request('/approve',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});
  h.resourceState.pages.canonical_deployment.deployment_trigger.metadata.commit_hash='b'.repeat(40);
  const result=await h.request('/verify',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});
  assert.equal(result.status,303);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'pending_deployment');
 }finally{globalThis.fetch=originalFetch}
});
test('missing expected commit cannot produce live result even with HTTP 200',async()=>{
 const h=harness();globalThis.fetch=h.fetchFn;
 try{
  const {sessionCookie}=await bootstrap(h);await connectCloudflare(h,sessionCookie);
  const csrf=csrfFrom(await (await h.request('/',{cookie:sessionCookie})).text());
  await h.request('/account',{method:'POST',cookie:sessionCookie,body:form({csrf,accountId})});
  const pre=await h.request('/preview',{method:'POST',cookie:sessionCookie,body:form({csrf,name:'Willow Studio'})});
  const id=new URL(origin+pre.headers.get('location')).searchParams.get('id');
  await h.request('/approve',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});
  const record=h.sqlite.prepare('SELECT provision_result FROM onboarding_launches').get();
  const config=JSON.parse(record.provision_result);delete config.headCommitSha;
  h.sqlite.prepare('UPDATE onboarding_launches SET provision_result=?').run(JSON.stringify(config));
  const result=await h.request('/verify',{method:'POST',cookie:sessionCookie,body:form({csrf,id})});
  assert.equal(result.status,400);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_launches').get().status,'pending_deployment');
 }finally{globalThis.fetch=originalFetch}
});

test('product onboarding shows Launch & Own identity and customer ownership tagline',async()=>{
 const h=harness();
 const result=await h.request('/');
 const html=await result.text();
 assert.match(html,/Launch & Own/);
 assert.match(html,/Describe it\. Launch it\. Own it\./);
});
