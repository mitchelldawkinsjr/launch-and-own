import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
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
 const migrateJobs=()=>sqlite.exec(readFileSync(new URL('./migrations/0004_launch_jobs.sql',import.meta.url),'utf8'));
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
 const resourceState={repo:null,homepage:false,homepageHtml:null,pages:null,failPagesOnce:false,
  failGitHubRevokeOnce:false,issueExpiringGrants:false,failRefreshOnce:false,githubUserId:42};
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
  if(url.includes('/accounts?page=1'))return Response.json({success:true,result:[{id:accountId,name:'Demo Account'}]});
  const acct=url.match(/\/accounts\/([a-f0-9]{32})$/);
  if(acct){
    if(resourceState.cloudflareRevoked)return new Response(null,{status:403});
    return Response.json({success:true,result:{id:acct[1],name:'Demo Account'}});
  }
  const root='https://api.github.com/repos/tester/esp-willow-studio';
  const pages='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/pages/projects';
  if(url===root && opts.method!=='POST')return resourceState.repo?Response.json(resourceState.repo):new Response('{}',{status:404});
  if(url==='https://api.github.com/user/repos' && opts.method==='POST'){
    resourceState.repo={id:101,owner:{login:'tester',id:resourceState.githubUserId},name:'esp-willow-studio',description:JSON.parse(opts.body).description,private:true,default_branch:'main'};
    return Response.json(resourceState.repo,{status:201});
  }
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
      resourceState.homepage=true;resourceState.homepageHtml=Buffer.from(JSON.parse(opts.body).content,'base64').toString('utf8');
      return Response.json({commit:{sha:GENERATED_SHA,tree:{sha:GENERATED_TREE}}},{status:201});
    }
    return resourceState.homepage&&new URL(url).searchParams.get('ref')!==BASE_SHA
      ?Response.json({type:'file',encoding:'base64',content:Buffer.from(resourceState.homepageHtml).toString('base64')})
      :new Response('{}',{status:404});
  }
  if(url===pages+'/esp-willow-studio-site')return resourceState.pages?Response.json({success:true,result:resourceState.pages}):new Response('{}',{status:404});
  if(url===pages && opts.method==='POST'){
    if(resourceState.pagesError)return Response.json({success:false},{status:resourceState.pagesError});
    if(resourceState.failPagesOnce){resourceState.failPagesOnce=false;return Response.json({success:false},{status:503})}
    resourceState.pages={id:'pages-stable-101',name:'esp-willow-studio-site',
     subdomain:'esp-willow-studio-site.pages.dev',production_branch:'main',
     build_config:JSON.parse(opts.body).build_config,source:{type:'github',config:{owner:'tester',repo_name:'esp-willow-studio',repo_id:'101'}},
     canonical_deployment:{id:'deploy-success',environment:'production',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{commit_hash:GENERATED_SHA}}}};
    return Response.json({success:true,result:resourceState.pages},{status:201});
  }
  if(url==='https://esp-willow-studio-site.pages.dev/')return new Response(resourceState.publicHtml??resourceState.homepageHtml,{status:200,headers:{'content-type':'text/html'}});
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
