import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyExistingPrPreview} from './pages-pr-preview.mjs';

const sha='a'.repeat(40), baseSha='d'.repeat(40), otherSha='b'.repeat(40);
const html='<!doctype html><html><body>Exactly approved</body></html>';
const htmlDigest=createHash('sha256').update(html).digest('hex');
const branch='launch-and-own/site-'+'c'.repeat(20);
const repoName='esp-willow-studio', projectName=repoName+'-site';
const deploymentId='77fbfbba-9f0e-40f1-89c5-bb82d9787905';
const cloudflareAccountId='1'.repeat(32), previewLabel='a1234567';
const previewUrl='https://'+previewLabel+'.'+projectName+'.pages.dev';
const site={githubOwner:'tester',githubUserId:42,githubRepositoryId:101,
  githubRepositoryName:repoName,cloudflareAccountId,pagesProjectId:'pages-p-1',
  pagesProjectName:projectName,productionBranch:'main'};
const consent={explicitlyApproved:true,publicExposureAcknowledged:true,
  githubUserId:42,githubRepositoryId:101,cloudflareAccountId,pagesProjectId:'pages-p-1',
  prNumber:55,approvedHeadSha:sha,approvedBaseSha:baseSha,approvedHtmlSha256:htmlDigest,
  expiresAt:Math.floor(Date.now()/1000)+3600};
const input={site,consent,prNumber:55,deploymentId};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function harness(){
 const state={
  user:{id:42,login:'tester'},
  repo:{id:101,name:repoName,private:true,default_branch:'main',
    description:'Launch & Own managed site: willow-studio',owner:{id:42,login:'tester'}},
  pr:{number:55,state:'open',base:{ref:'main',sha:baseSha,repo:{id:101,owner:{id:42}}},
    head:{ref:branch,sha,repo:{id:101,owner:{id:42}}}},
  branch:{commit:{sha}},baseBranch:{commit:{sha:baseSha}},
  project:{id:'pages-p-1',name:projectName,subdomain:projectName+'.pages.dev',
    production_branch:'main',uses_functions:false,
    build_config:{build_command:'',root_dir:'/',destination_dir:'public'},
    source:{type:'github',config:{owner:'tester',owner_id:'42',repo_name:repoName,
      repo_id:'101',production_deployments_enabled:true,
      preview_deployment_setting:'custom',preview_branch_includes:['launch-and-own/site-*'],
      preview_branch_excludes:['main'],pr_comments_enabled:false}}},
  deployment:{id:deploymentId,project_id:'pages-p-1',short_id:previewLabel,
    project_name:projectName,environment:'preview',is_skipped:false,
    latest_stage:{name:'deploy',status:'success'},url:previewUrl,
    deployment_trigger:{type:'github:push',metadata:{branch,commit_hash:sha,commit_dirty:false}}},
  html,htmlStatus:200,htmlContentType:'text/html; charset=utf-8',forbidden:null
 };
 const calls=[];
 const ghRoot='https://api.github.com/repos/tester/'+repoName;
 const cfRoot='https://api.cloudflare.com/client/v4/accounts/'+cloudflareAccountId+'/pages/projects/'+projectName;
 const fetchFn=async(url,options={})=>{
  calls.push({url,method:options.method,redirect:options.redirect});
  assert.equal(options.method,'GET','preview inspection never mutates a provider');
  assert.equal(options.redirect,'manual','do not follow provider/public redirects');
  if(state.forbidden && url.includes(state.forbidden))return json({},403);
  if(url==='https://api.github.com/user')return json(state.user);
  if(url===ghRoot)return json(state.repo);
  if(url===ghRoot+'/pulls/55')return json(state.pr);
  if(url===ghRoot+'/branches/main')return json(state.baseBranch);
  if(url===ghRoot+'/branches/'+encodeURIComponent(branch))return json(state.branch);
  if(url===cfRoot)return json({success:true,result:state.project});
  if(url===cfRoot+'/deployments/'+deploymentId)return json({success:true,result:state.deployment});
  if(url===previewUrl+'/index.html')return new Response(state.html,{status:state.htmlStatus,
    headers:{'content-type':state.htmlContentType}});
  throw Error('Unexpected request '+url);
 };
 return {state,calls,fetchFn};
}
const auth={githubToken:'test-gh',cloudflareToken:'test-cf'};
const verify=(h,update=input)=>verifyExistingPrPreview(update,{...auth,fetchFn:h.fetchFn});
const noPublicCall=h=>assert(h.calls.every(c=>c.url.startsWith('https://api.github.com/') ||
  c.url.startsWith('https://api.cloudflare.com/')), 'No preview URL or page content is fetched');
test('metadata-only success never returns URL, content or a claim of Access protection',async()=>{
 const h=harness(),r=await verify(h);
 assert.deepEqual(r,{status:'preview-metadata-verified-protection-pending',previewUrl:null,
  deploymentId,githubBaseSha:baseSha,githubHeadSha:sha,environment:'preview',
  protectionVerified:false,contentVerified:false,productionVerified:false,
  note:'Deployment metadata only; access protection and signed-in canonical content have not been verified.'});
 assert.equal(h.calls.length,7);
 assert(h.calls.every(c=>c.method==='GET'&&c.redirect==='manual'));
 assert(!JSON.stringify(r).includes('test-gh'));
 assert(!JSON.stringify(r).includes('pages.dev'));
 assert(!JSON.stringify(r).includes(previewLabel));
 noPublicCall(h);
});
test('approval, expiry, tenant and privacy gate before any network',async()=>{
 for(const bad of [
  {...consent,explicitlyApproved:false},
  {...consent,publicExposureAcknowledged:false},
  {...consent,privatePreviewRequired:true},
  {...consent,expiresAt:0},
  {...consent,githubRepositoryId:999},
  {...consent,githubUserId:22},
  {...consent,pagesProjectId:'wrong'},
  {...consent,cloudflareAccountId:'f'.repeat(32)},
  {...consent,prNumber:66},
  {...consent,approvedHeadSha:'no'},
  {...consent,approvedBaseSha:'no'},
  {...consent,approvedBaseSha:undefined},
  {...consent,approvedHtmlSha256:'invalid'}
 ]){
  const h=harness(),r=await verify(h,{...input,consent:bad});
  assert.equal(r.status,'blocked-approval-or-inventory');
  assert.equal(r.previewUrl,null);assert.equal(h.calls.length,0);
 }
});
test('missing and revoked connections do not expose URL',async()=>{
 const h=harness();
 assert.equal((await verifyExistingPrPreview(input,{githubToken:'',cloudflareToken:'cf',fetchFn:h.fetchFn})).status,'reauthorization-required');
 assert.equal(h.calls.length,0);
 h.state.forbidden='/user';
 await assert.rejects(verify(h),/authorization is unavailable/);
 assert(!h.calls.some(c=>c.url.includes('/index.html')));
});
test('GitHub immutable owner/repo, marker and private property must match',async()=>{
 for(const change of [
  s=>s.user.id=44,s=>s.repo.id=999,s=>s.repo.owner.id=44,
  s=>s.repo.description='unmanaged',s=>s.repo.private=false,
  s=>s.repo.default_branch='dev',s=>s.repo.owner.login='other'
 ]){
  const h=harness();change(h.state);
  const r=await verify(h);assert.equal(r.status,'blocked-github-ownership');
  assert.equal(r.previewUrl,null);
  assert(!h.calls.some(c=>c.url.includes('/deployments/')));
 }
});
test('Cloudflare project, source repo and build settings must match',async()=>{
 for(const change of [
  s=>s.project.id='wrong',
  s=>s.project.source.config.repo_id='998',
  s=>s.project.source.config.repo_id='000101',
  s=>s.project.source.config.owner_id='44',
  s=>s.project.source.config.owner_id='not-a-number',
  s=>s.project.source.config.owner_id='9007199254740997',
  s=>s.project.source.config.repo_name='other',
  s=>s.project.source.config.owner='another',
  s=>s.project.production_branch='dev',
  s=>s.project.uses_functions=true,
  s=>s.project.build_config.destination_dir='dist'
 ]){
  const h=harness();change(h.state);
  const r=await verify(h);assert.equal(r.status,'blocked-pages-project-identity');
  assert.equal(r.previewUrl,null);
 }
});
test('disabled and unsafe preview configurations always fail closed',async()=>{
 for(const [change,status] of [
  [s=>s.project.source.config.preview_deployment_setting='none','preview-disabled'],
  [s=>s.project.source.config.preview_deployment_setting='all','blocked-unsafe-preview-policy'],
  [s=>s.project.source.config.preview_branch_includes=['*'],'blocked-unsafe-preview-policy'],
  [s=>s.project.source.config.preview_branch_includes.push('main'),'blocked-unsafe-preview-policy'],
  [s=>s.project.source.config.preview_branch_excludes=[],'blocked-unsafe-preview-policy'],
  [s=>s.project.source.config.preview_branch_excludes=['dev'],'blocked-unsafe-preview-policy'],
  [s=>s.project.source.config.preview_branch_excludes=['main','dev'],'blocked-unsafe-preview-policy'],
  [s=>{delete s.project.source.config.preview_branch_excludes;},'blocked-unsafe-preview-policy'],
  [s=>s.project.source.config.pr_comments_enabled=true,'blocked-unsafe-preview-policy'],
  [s=>{delete s.project.source.config.pr_comments_enabled;},'blocked-unsafe-preview-policy']
 ]){
  const h=harness();change(h.state);
  const r=await verify(h);assert.equal(r.status,status);
  assert.equal(r.previewUrl,null);
  assert(!h.calls.some(c=>c.url.includes('/deployments/')));
 }
});
test('approved GitHub PR/base/head SHA must match same repo and live branches',async()=>{
 for(const [change,status] of [
  [s=>s.pr.state='closed','blocked-pr-or-revision'],
  [s=>s.pr.head.repo.id=222,'blocked-pr-or-revision'],
  [s=>s.pr.head.repo.owner.id=222,'blocked-pr-or-revision'],
  [s=>s.pr.base.repo.id=222,'blocked-pr-or-revision'],
  [s=>s.pr.base.repo.owner.id=222,'blocked-pr-or-revision'],
  [s=>s.pr.head.ref='unapproved-draft','blocked-pr-or-revision'],
  [s=>s.pr.head.sha=otherSha,'blocked-pr-or-revision'],
  [s=>s.pr.base.sha=otherSha,'blocked-pr-or-revision'],
  [s=>s.baseBranch.commit.sha=otherSha,'blocked-pr-base-moved'],
  [s=>s.branch.commit.sha=otherSha,'blocked-pr-head-moved']
 ]) {
  const h=harness();change(h.state);
  const r=await verify(h);assert.equal(r.status,status);
  assert.equal(r.previewUrl,null);
  assert(!h.calls.some(c=>c.url.includes('/deployments/')));noPublicCall(h);
 }
});
test('Pages deployment must be exact successful Git preview and exact SHA',async()=>{
 for(const change of [
  s=>s.deployment.project_name='wrong',
  s=>s.deployment.project_id='wrong',
  s=>s.deployment.environment='production',
  s=>s.deployment.latest_stage.name='build',
  s=>s.deployment.latest_stage.status='active',
  s=>s.deployment.is_skipped=true,
  s=>s.deployment.deployment_trigger.type='ad_hoc',
  s=>s.deployment.deployment_trigger.metadata.branch='main',
  s=>s.deployment.deployment_trigger.metadata.commit_hash=otherSha,
  s=>s.deployment.deployment_trigger.metadata.commit_dirty=true
 ]){
  const h=harness();change(h.state);
  const r=await verify(h);assert.equal(r.status,'preview-not-verified');
  assert.equal(r.previewUrl,null);
  assert(!h.calls.some(c=>c.url.includes('/index.html')));
 }
});
test('never fetches arbitrary domains, branch aliases or changed short IDs',async()=>{
 for(const url of [
  'http://'+previewLabel+'.'+projectName+'.pages.dev',
  'https://attacker.example/',
  'https://'+projectName+'.pages.dev/',
  'https://x.y.'+projectName+'.pages.dev/',
  previewUrl+'/other',previewUrl+'/?token=x',
  'https://attacker.example@'+previewLabel+'.'+projectName+'.pages.dev/'
 ]){
  const h=harness();h.state.deployment.url=url;
  const r=await verify(h);assert.equal(r.status,'blocked-preview-url');
  assert(!h.calls.some(c=>c.url.includes('/index.html')));
 }
 const h=harness();h.state.deployment.short_id='c1234567';
 assert.equal((await verify(h)).status,'blocked-preview-url');
});
test('fake browser/access flags never change metadata-only result or trigger public GET',async()=>{
 const h=harness(),r=await verify(h,{...input,accessVerified:true,protectedPreview:true,
  consent:{...consent,protectionVerified:true,viewerAuthenticated:true},
  previewUrl:'https://attacker.example',canonicalPreviewHtmlSha256:htmlDigest});
 assert.equal(r.status,'preview-metadata-verified-protection-pending');
 assert.equal(r.previewUrl,null);assert.equal(r.protectionVerified,false);
 assert.equal(r.contentVerified,false);assert.equal(r.productionVerified,false);
 noPublicCall(h);
});
