import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import worker from './worker.mjs';

const origin='https://onboard.example.com';
const accountId='0123456789abcdef0123456789abcdef';
const GENERATED_SHA='a'.repeat(40);
const BASE_SHA='b'.repeat(40);
const BASE_TREE='c'.repeat(40);
const GENERATED_TREE='d'.repeat(40);
function harness({withJobs=true}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('PRAGMA foreign_keys = ON');
 sqlite.exec(readFileSync(new URL('./migrations/0001_initial.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('./migrations/0002_token_rotation.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('./migrations/0003_launch_receipts.sql',import.meta.url),'utf8'));
 const migrateJobs=()=>{
  sqlite.exec(readFileSync(new URL('./migrations/0004_launch_jobs.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0005_option_approvals.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0006_option_executions.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0007_option_kinds_analytics_previews.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0008_forms_cost_privacy_approvals.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0009_option_kinds_seo_redirects.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0010_forms_provisioning_receipts.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0011_cloudflare_pages_access.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0012_imported_edit_approvals.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0013_forms_worker_receipts.sql',import.meta.url),'utf8'));
 };
 if(withJobs)migrateJobs();
 const DB={
  prepare(sql){
   function bind(...args){
    const execute=()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}});
    return {
     execute,run:async()=>execute(),first:async()=>sqlite.prepare(sql).get(...args)||null,
     all:async()=>({results:sqlite.prepare(sql).all(...args)})
    };
   }
   return {...bind(),bind};
  },
  async batch(stmts){
   sqlite.exec('BEGIN');
   try{
    const results=stmts.map(stmt=>stmt.execute());
    sqlite.exec('COMMIT');
    return results;
   }catch(error){
    sqlite.exec('ROLLBACK');
    throw error;
   }
  }
 };
 const env={DB,ONBOARDING_LIMITER:{limit:async()=>({success:true})},ONBOARDING_ORIGIN:origin,TOKEN_ENCRYPTION_KEY:'abababababababababababababababababababababababababababababababab',GH_CLIENT_ID:'Iv1.example',GH_CLIENT_SECRET:'dummy-gh-secret',GH_APP_SLUG:'launch-and-own',CF_CLIENT_ID:'cf-client-id',CF_CLIENT_SECRET:'dummy-cf-secret',CF_SCOPES:'workers-platform.read workers-platform.write'};
 const calls=[];
 const resourceState={repo:null,homepage:false,homepageHtml:null,pages:null,customDomain:null,failPagesOnce:false,
  failGitHubRevokeOnce:false,issueExpiringGrants:false,failRefreshOnce:false,githubUserId:42,
  updateBranch:null,updateHtml:null,updatePr:null,updateFileWrites:0,denyPullRequests:false,
  denyPagesOAuth:false,denyPagesOAuthAtCreate:false,pagesAccessToken:null};
 const fetchFn=async(url,opts={})=>{
  calls.push({url,method:opts.method||'GET'});
  if(url==='https://github.com/login/oauth/access_token'){
    const body=new URLSearchParams(opts.body);
    if(body.get('grant_type')==='refresh_token'){
      if(resourceState.failRefreshOnce){resourceState.failRefreshOnce=false;return Response.json({error:'bad_refresh_token'},{status:401})}
      return Response.json({access_token:'ghu_rotated_access',token_type:'bearer',expires_in:28800,refresh_token:'ghr_rotated',refresh_token_expires_in:15897600});
    }
    return resourceState.issueExpiringGrants?
      Response.json({access_token:'ghu_secret_example',token_type:'bearer',expires_in:180,refresh_token:'ghr_initial',refresh_token_expires_in:15897600}):
      Response.json({access_token:'ghu_secret_example',token_type:'bearer'});
  }
  if(url==='https://api.github.com/user'){
    if(resourceState.githubRevoked)return new Response(null,{status:401});
    return Response.json({login:'tester',id:resourceState.githubUserId});
  }
  if(url.startsWith('https://api.github.com/user/installations')){
    if(resourceState.githubRevoked)return new Response(null,{status:401});
    if(resourceState.appNotInstalled)return Response.json({installations:[]});
    return Response.json({installations:[{
      app_slug:'launch-and-own',
      account:{login:'tester',type:'User'},
      permissions:{repository_creation:'write',contents:'write',metadata:'read',pull_requests:'write'}
    },{
      app_slug:'cloudflare-workers-and-pages',
      account:{login:'tester',type:'User'},
      permissions:{administration:'write',contents:'write',metadata:'read',pull_requests:'write'}
    }]});
  }
  if(url==='https://api.github.com/applications/Iv1.example/grant'){
    if(resourceState.failGitHubRevokeOnce){resourceState.failGitHubRevokeOnce=false;return new Response(null,{status:503})}
    return new Response(null,{status:204});
  }
  if(url==='https://dash.cloudflare.com/oauth2/revoke')return new Response(null,{status:200});
  if(url==='https://dash.cloudflare.com/oauth2/token'){
    const body=new URLSearchParams(opts.body);
    if(body.get('grant_type')==='refresh_token')
      return Response.json({access_token:'cf_rotated_access',token_type:'bearer',expires_in:3600,refresh_token:'cf_rotated_refresh'});
    return resourceState.issueExpiringGrants?
      Response.json({access_token:'cf_secret_example',token_type:'bearer',expires_in:180,refresh_token:'cf_initial_refresh'}):
      Response.json({access_token:'cf_secret_example',token_type:'bearer'});
  }
  if(url.includes('/accounts?page=1')){
    if(resourceState.cloudflareRevoked)return new Response(null,{status:403});
    return Response.json({success:true,result:[{id:accountId,name:'Demo Account'},{id:'f'.repeat(32),name:'Alt Account'}]});
  }
  const acct=url.match(/\/accounts\/([a-f0-9]{32})$/);
  if(acct){
    if(resourceState.cloudflareRevoked)return new Response(null,{status:403});
    return Response.json({success:true,result:{id:acct[1],name:'Demo Account'}});
  }
  const rum=url.match(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})\/rum\/site_info(\/list\?per_page=100)?$/);
  if(rum){
    if(resourceState.cloudflareRevoked)return new Response(null,{status:401});
    if(resourceState.denyAnalytics)return Response.json({success:false,errors:[{code:10000}]},{status:403});
    resourceState.rumSites??=[];
    if(rum[2])return Response.json({success:true,result:resourceState.rumSites});
    if(opts.method==='POST'){
      const site={site_tag:'7a'.repeat(16),site_token:'7b'.repeat(16),host:JSON.parse(opts.body).host,auto_install:false};
      resourceState.rumSites.push(site);
      return Response.json({success:true,result:site});
    }
  }
  const pagesAccount=url.match(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})\/pages\/projects(?:[/?]|$)/);
  if(pagesAccount){
    const bearer=new Headers(opts.headers).get('authorization');
    const hasPagesAccess=resourceState.pagesAccessToken&&pagesAccount[1]===accountId&&
      bearer==='Bearer '+resourceState.pagesAccessToken;
    if(opts.method==='POST'&&url.endsWith('/pages/projects')&&resourceState.denyPagesOAuthAtCreate&&!hasPagesAccess)
      resourceState.denyPagesOAuth=true;
    if(resourceState.denyPagesOAuth&&!hasPagesAccess)
      return Response.json({success:false,errors:[{code:10000,message:'Test fixture denied Pages access'}]},{
        status:401,headers:{'cf-ray':'0123456789abcdef-IAD'}
      });
  }
  const pagesList=url.match(/\/accounts\/([a-f0-9]{32})\/pages\/projects(?:\?|$)/);
  if(pagesList&&(opts.method||'GET')==='GET'&&!url.includes('/pages/projects/')){
    if(resourceState.cloudflareRevoked)return new Response(null,{status:401});
    const listed=resourceState.pages&&pagesList[1]===accountId
      ?[{id:resourceState.pages.id,name:resourceState.pages.name}]:[];
    return Response.json({success:true,result:listed,result_info:{
      page:1,per_page:3,total_pages:listed.length?1:0,total_count:listed.length}});
  }
  const root='https://api.github.com/repos/tester/esp-willow-studio';
  const pages='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/pages/projects';
  if(url===root && opts.method!=='POST'){
    if(resourceState.invalidateSessionOnRepoRead){
      resourceState.invalidateSessionOnRepoRead=false;
      sqlite.prepare('UPDATE onboarding_sessions SET authorization_epoch=authorization_epoch+1').run();
    }
    return resourceState.repo?Response.json(resourceState.repo):new Response('{}',{status:404});
  }
  if(url==='https://api.github.com/user/repos' && opts.method==='POST'){
    resourceState.repo={id:101,owner:{login:'tester',id:resourceState.githubUserId},name:'esp-willow-studio',description:JSON.parse(opts.body).description,private:true,default_branch:'main'};
    return Response.json(resourceState.repo,{status:201});
  }
  if(url.startsWith(root+'/branches/')&&decodeURIComponent(url.slice((root+'/branches/').length)).startsWith('launch-and-own/site-')){
    const name=decodeURIComponent(url.slice((root+'/branches/').length));
    return resourceState.updateBranch===name?Response.json({commit:{sha:resourceState.updateHtml?'f'.repeat(40):GENERATED_SHA}}):new Response('{}',{status:404});
  }
  if(url===root+'/git/refs'&&opts.method==='POST'){
    const payload=JSON.parse(opts.body);
    resourceState.updateBranch=payload.ref.replace(/^refs\/heads\//,'');
    resourceState.updateBaseSha=payload.sha;
    return Response.json({ref:'refs/heads/'+resourceState.updateBranch},{status:201});
  }
  if(url===root+'/commits/'+'f'.repeat(40)&&resourceState.updateHtml){
    const body=Buffer.from(resourceState.updateHtml,'utf8');
    const sha=createHash('sha1').update('blob '+body.byteLength+'\0').update(body).digest('hex');
    return Response.json({sha:'f'.repeat(40),parents:[{sha:resourceState.updateBaseSha}],
      files:[{filename:'public/index.html',status:'modified',sha}]});
  }
  if(url.startsWith(root+'/pulls?')&&opts.method==='GET')return Response.json(resourceState.updatePr?[resourceState.updatePr]:[]);
  if(url===root+'/pulls'&&opts.method==='POST'){
    if(resourceState.denyPullRequests)return new Response('{}',{status:403});
    const payload=JSON.parse(opts.body);
    resourceState.updatePr={number:55,state:'open',html_url:'https://github.com/tester/esp-willow-studio/pull/55',
      head:{ref:payload.head,sha:'f'.repeat(40),repo:{id:101,full_name:'tester/esp-willow-studio'}},
      base:{ref:'main',sha:resourceState.headSha??GENERATED_SHA,repo:{id:101}},
      merged_at:null,merge_commit_sha:null};
    return Response.json(resourceState.updatePr,{status:201});
  }
  if(url===root+'/pulls/55/merge'&&opts.method==='PUT'){
    // "Approve and publish": merges only the exact approved head; a test can make GitHub refuse.
    const payload=JSON.parse(opts.body);
    resourceState.merges=(resourceState.merges||[]).concat([payload]);
    if(resourceState.denyMerge||!resourceState.updatePr||payload.sha!==resourceState.updatePr.head.sha)return new Response('{}',{status:405});
    resourceState.updatePr={...resourceState.updatePr,state:'closed',merged:true,merged_at:'2026-11-26T12:00:00Z',merge_commit_sha:'9'.repeat(40)};
    return Response.json({merged:true,sha:'9'.repeat(40)});
  }
  if(url===root+'/pulls/55')return resourceState.updatePr?Response.json(resourceState.updatePr):new Response('{}',{status:404});
  if(url===root+'/branches/main')return Response.json({commit:{
    sha:resourceState.headSha??(resourceState.homepage?GENERATED_SHA:BASE_SHA),
    commit:{tree:{sha:resourceState.homepage?GENERATED_TREE:BASE_TREE}}
  }});
  if(url.startsWith(root+'/git/trees/')){
    const entries=[{path:'README.md',mode:'100644'}];
    if(url.includes(GENERATED_TREE))entries.push({path:'public',mode:'040000'},{path:'public/index.html',mode:'100644'});
    if(resourceState.extraTreePath)entries.push({path:resourceState.extraTreePath,mode:'100644'});
    return Response.json({truncated:false,tree:entries});
  }
  if(url.startsWith(root+'/contents/public/index.html')){
    if(opts.method==='PUT'){
      const payload=JSON.parse(opts.body),html=Buffer.from(payload.content,'base64').toString('utf8');
      if(payload.branch&&payload.branch!=='main'){
        if(payload.branch!==resourceState.updateBranch)throw Error('Wrong update branch');
        resourceState.updateHtml=html;resourceState.updateFileWrites++;
        return Response.json({commit:{sha:'f'.repeat(40)}},{status:200});
      }
      resourceState.homepage=true;resourceState.homepageHtml=html;
      return Response.json({commit:{sha:GENERATED_SHA,tree:{sha:GENERATED_TREE}}},{status:201});
    }
    const ref=new URL(url).searchParams.get('ref');
    const file=(html)=>({
      type:'file',sha:'e'.repeat(40),encoding:'base64',
      content:Buffer.from(html).toString('base64'),size:Buffer.byteLength(html)
    });
    if(ref===resourceState.updateBranch&&resourceState.updateBranch)
      return Response.json(file(resourceState.updateHtml??resourceState.homepageHtml));
    return resourceState.homepage&&ref!==BASE_SHA
      ?Response.json(file(resourceState.homepageHtml))
      :new Response('{}',{status:404});
  }
  if(url===pages+'/esp-willow-studio-site')return resourceState.pages?Response.json({success:true,result:resourceState.pages}):new Response('{}',{status:404});
  if(url===pages+'/esp-willow-studio-site/domains/www.example.com' && opts.method!=='POST'){
    if(resourceState.replaceOptionWhileReadingDomain){
      resourceState.replaceOptionWhileReadingDomain=false;
      sqlite.prepare("UPDATE onboarding_option_approvals SET id = ? WHERE kind = 'domain'")
        .run('99999999-9999-4999-8999-999999999999');
    }
    return resourceState.customDomain
      ?Response.json({success:true,result:resourceState.customDomain})
      :new Response('{}',{status:404});
  }
  if(url===pages+'/esp-willow-studio-site/domains' && opts.method==='POST'){
    const body=JSON.parse(opts.body);
    if(body.name!=='www.example.com')throw Error('Unexpected domain attachment');
    resourceState.customDomain={name:body.name,status:'pending'};
    return Response.json({success:true,result:resourceState.customDomain},{status:201});
  }
  if(url===pages && opts.method==='POST'){
    if(resourceState.pagesError)return Response.json({success:false},{status:resourceState.pagesError});
    if(resourceState.failPagesOnce){resourceState.failPagesOnce=false;return Response.json({success:false},{status:503})}
    resourceState.pages={id:'pages-stable-101',name:'esp-willow-studio-site',
     subdomain:'esp-willow-studio-site.pages.dev',production_branch:'main',uses_functions:false,
     build_config:JSON.parse(opts.body).build_config,source:{type:'github',config:{
       owner:'tester',owner_id:String(resourceState.githubUserId),repo_name:'esp-willow-studio',
       repo_id:'101',production_deployments_enabled:true,preview_deployment_setting:'none'}},
     canonical_deployment:{id:'deploy-success',environment:'production',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{commit_hash:GENERATED_SHA}}}};
    return Response.json({success:true,result:resourceState.pages},{status:201});
  }
  // Owned-zone + pre-existing ready email routing mocks. No MX/DNS mutation handler.
  const parsed=new URL(url);
  const zoneId='b'.repeat(32);
  const page=result=>Response.json({success:true,result,
    result_info:{page:1,total_pages:1}});
  const accountPage=result=>Response.json({success:true,result,
    result_info:{page:1,per_page:50,count:result.length,total_count:result.length}});
  if(parsed.pathname==='/client/v4/zones'&&parsed.searchParams.get('account.id')===accountId)
    return page([{id:zoneId,name:'example.com',status:'active',account:{id:accountId}}]);
  if(parsed.pathname==='/client/v4/zones/'+zoneId+'/email/routing'&&opts.method!=='POST')
    return page({enabled:true,status:'ready'});
  if(parsed.pathname==='/client/v4/zones/'+zoneId+'/dns_records'&&opts.method==='GET'&&
      parsed.searchParams.get('type')==='MX') {
    const hostname=parsed.searchParams.get('name.exact');
    return accountPage(resourceState.routingMxRecords ?? [1,2,3].map((n,i)=>({
      type:'MX',name:hostname,content:'route'+n+'.mx.cloudflare.net',priority:10+i*10
    })));
  }
  if(parsed.pathname==='/client/v4/accounts/'+accountId+'/email/routing/addresses'&&opts.method!=='POST')
    return accountPage([{email:'existing@example.net',verified:'2026-11-22T01:00:00Z'}]);
  if(parsed.pathname==='/client/v4/accounts/'+accountId+'/email/routing/rules'&&opts.method!=='POST')
    return accountPage(resourceState.emailRules||[]);
  if(parsed.pathname==='/client/v4/zones/'+zoneId+'/email/routing/rules'&&opts.method==='POST'){
    const rule={...JSON.parse(opts.body),id:'rule-1',zone:{tag:zoneId}};
    resourceState.emailRules=[rule];
    return page(rule);
  }
  if(url==='https://esp-willow-studio-site.pages.dev/'){
    // Like Pages: a project with Web Analytics gets the beacon added before </body> on deploy.
    const token=resourceState.pages?.build_config?.web_analytics_token;
    const served=resourceState.publicHtml??resourceState.homepageHtml;
    const beacon='<!-- Cloudflare Pages Analytics --><script defer src=\'https://static.cloudflareinsights.com/beacon.min.js\' data-cf-beacon=\'{"token": "'+token+'"}\'></script><!-- Cloudflare Pages Analytics -->';
    const html=token&&typeof served==='string'&&served.includes('</body>')?served.replace('</body>',beacon+'</body>'):served;
    return new Response(html,{status:200,headers:{'content-type':'text/html'}});
  }
  throw Error('unmocked external request: '+url);
 };
 const request=async(path,opts={})=>{
  const background=[];
  const context=opts.skipFastPath?undefined:{waitUntil(promise){background.push(promise)}};
  const response=await worker.fetch(new Request(origin+path,{method:opts.method||'GET',headers:{
   ...(opts.cookie?{cookie:opts.cookie}:{}),
   ...(opts.method==='POST'?{'content-type':'application/x-www-form-urlencoded',origin}:{}),...opts.headers},body:opts.body}),env,context);
  await Promise.all(background);
  return response;
 };
 return {sqlite,env,DB,request,fetchFn,calls,resourceState,migrateJobs};
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
const post=(h,path,cookie,values,options={})=>h.request(path,{method:'POST',cookie,body:form(values),...options});
async function reviewDigest(h,cookie,id){
 const response=await h.request('/review?id='+id,{cookie});
 const html=await response.text();
 const match=html.match(/name="digest" value="([a-f0-9]{64})"/);
 assert(match,'reviewed approval digest');
 return match[1];
}
async function approvePreview(h,cookie,csrf,id,options){
 return await post(h,'/approve',cookie,{csrf,id,digest:await reviewDigest(h,cookie,id)},options);
}
const launchId=response=>new URL(origin+response.headers.get('location')).searchParams.get('id');
const jobRow=h=>h.sqlite.prepare('SELECT * FROM onboarding_launch_jobs').get();
const makeDue=h=>h.sqlite.prepare('UPDATE onboarding_launch_jobs SET next_attempt_at=0').run();
const moveLeaseIntoPast=h=>h.sqlite.prepare('UPDATE onboarding_launch_jobs SET lease_until=0 WHERE lease_id IS NOT NULL').run();
const writes=h=>h.calls.filter(call=>call.method==='PUT'||call.url.endsWith('/user/repos')||
 (call.method==='POST'&&call.url.endsWith('/pages/projects')));
async function connectTenant(h){
 const {sessionCookie:cookie}=await bootstrap(h);
 await connectCloudflare(h,cookie);
 const csrf=csrfFrom(await (await h.request('/',{cookie})).text());
 assert.equal((await post(h,'/account',cookie,{csrf,accountId})).status,303);
 return {cookie,csrf};
}
async function newPreview(h,tenant,fields={}){
 const response=await post(h,'/preview',tenant.cookie,{csrf:tenant.csrf,name:'Willow Studio',...fields});
 assert.equal(response.status,303);
 return launchId(response);
}
const originalFetch=globalThis.fetch;

export { accountId, approvePreview, bootstrap, connectCloudflare, connectTenant, csrfFrom, form, GENERATED_SHA,
 harness, jobRow, launchId, makeDue, moveLeaseIntoPast, newPreview, origin, originalFetch, post, reviewDigest, writes };
