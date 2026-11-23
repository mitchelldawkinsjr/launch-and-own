import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRedirectOptInReview} from '../pipeline/option-feature-review.mjs';
import {buildStaticRedirectReviewProposal} from './redirect-review-proposal.mjs';

const account='a'.repeat(32);
const sourceSha='b'.repeat(40);
const treeSha='c'.repeat(40);
const uuid='12345678-1234-4234-8234-123456789abc';
const hostname='site.example.com';
const site=()=>({
  jobId:uuid,githubUserId:42,githubRepositoryId:77,
  cloudflareAccountId:account,pagesProjectId:'pages_01',
  pagesProjectName:'esp-willow-site',expectedBaseSha:sourceSha,branch:'main'
});
const domain=()=>({
  kind:'verified-owned-domain',githubUserId:42,githubRepositoryId:77,
  cloudflareAccountId:account,pagesProjectId:'pages_01',
  pagesProjectName:'esp-willow-site',sourceSha,
  origin:'https://'+hostname,checkedAt:Math.floor(Date.now()/1000)-30,
  expiresAt:Math.floor(Date.now()/1000)+300
});
function option({from='/old',to='/',wwwMode='none',host=hostname}={}) {
  const review=buildRedirectOptInReview({
    githubUserId:42,cloudflareAccountId:account,hostname:host,
    redirectConsent:true,wwwMode,pathFrom:from,pathTo:to
  });
  assert.equal(review.status,'awaiting_redirect_opt_in');
  return {
    id:'abcdefab-cdef-4def-8def-abcdefabcdef',jobId:uuid,
    githubUserId:42,cloudflareAccountId:account,kind:'redirects',
    status:'stored',digest:review.approvalDigest,
    normalizedPayload:{
      hostname:review.plan.hostname,wwwMode:review.plan.proposed.wwwMode,
      pathRules:review.plan.proposed.pathRules
    },
    canWrite:false,canActivate:false
  };
}
function entry(path,type='blob',mode=type==='tree'?'040000':'100644') {
  return {path,type,mode,sha:'d'.repeat(40)};
}
function tree(kind='generated-one-page') {
  const tree=[entry('README.md'),entry('public','tree'),entry('public/index.html')];
  if(kind==='generated-multi-page')
    for(const d of ['about','services','contact']) {
      tree.push(entry('public/'+d,'tree'),entry('public/'+d+'/index.html'));
    }
  return {sha:treeSha,truncated:false,tree};
}
function fixture(kind='generated-one-page') {
  return {
    sourceKind:kind,storedOption:option(),trustedSite:site(),
    domainEvidence:domain(),mainBranch:{name:'main',commit:{sha:sourceSha}},
    pinnedCommit:{sha:sourceSha,tree:{sha:treeSha}},pinnedTree:tree(kind),
    assertCurrentAuthorization:async()=>true
  };
}
const blocked=async (f,status)=> {
  const result=await buildStaticRedirectReviewProposal(f);
  assert.equal(result.status,status,JSON.stringify(result));
  assert.deepEqual(result.files,[]);
  assert.equal(result.readyForProviderWrite,false);
  assert.equal(result.publicationVerified,false);
};

test('one-page generated site creates only one exact reviewable _redirects file',async()=>{
  const input=fixture();
  const result=await buildStaticRedirectReviewProposal(input);
  assert.equal(result.status,'review-required');
  assert.equal(result.hostname,hostname);
  assert.deepEqual(result.files.map(f=>f.path),['public/_redirects']);
  assert.equal(result.files[0].content,'/old / 301\n');
  assert.equal(result.files[0].action,'review-create');
  assert.equal(result.files[0].beforeSha256,null);
  assert.match(result.files[0].afterSha256,/^[a-f0-9]{64}$/);
  assert.match(result.proposalSha256,/^[a-f0-9]{64}$/);
  assert.equal(result.readyForProviderWrite,false);
  assert.equal(result.publicationVerified,false);
  assert.equal(result.requiresOwnerApproval,true);
  assert.equal(result.requiresVerifiedGitUpdate,true);
  assert.equal((await buildStaticRedirectReviewProposal(input)).proposalSha256,result.proposalSha256);
});

test('four-page generated site accepts a legacy path to a known existing route',async()=>{
  const input=fixture('generated-multi-page');
  input.storedOption=option({from:'/old-services',to:'/services/'});
  const output=await buildStaticRedirectReviewProposal(input);
  assert.equal(output.status,'review-required');
  assert.equal(output.files[0].content,'/old-services /services/ 301\n');
  assert.equal(output.files.length,1);
});

test('ZIP, custom, and unrecognized sources require manual review, not modifications',async()=>{
  for(const kind of ['imported-zip','custom','statically-generated','']) {
    const input=fixture();
    input.sourceKind=kind;
    await blocked(input,'manual-review-required');
  }
});

test('an apex/www request cannot pretend to be a Pages-only static file operation',async()=>{
  for(const wwwMode of ['apex_to_www','www_to_apex']) {
    const input=fixture();
    input.storedOption=option({wwwMode});
    await blocked(input,'manual-review-required');
  }
});

test('stored option must be genuine status/owner/tenant/job/digest and fail closed on payload changes',async()=>{
  for(const patch of [
    {status:'approved'},{canWrite:true},{canActivate:true},
    {jobId:'ffffffff-ffff-4fff-8fff-ffffffffffff'},
    {githubUserId:17},{cloudflareAccountId:'e'.repeat(32)},
    {digest:'0'.repeat(64)},{kind:'domain'}
  ]) {
    const input=fixture();
    input.storedOption={...input.storedOption,...patch};
    await blocked(input,'blocked-stored-approval');
  }
  const input=fixture();
  input.storedOption={...input.storedOption,
    normalizedPayload:{...input.storedOption.normalizedPayload,hostname:'evil.example.org'}};
  await blocked(input,'blocked-stored-approval');
});

test('owner domain evidence must match exact hostname, account, repo and current SHA',async()=>{
  for(const patch of [
    {origin:'https://evil.example.com'},{origin:'http://'+hostname},
    {origin:'https://'+hostname+':8443'},
    {githubUserId:55},{githubRepositoryId:555},{pagesProjectId:'other'},
    {sourceSha:'e'.repeat(40)},{cloudflareAccountId:'e'.repeat(32)},
    {checkedAt:Math.floor(Date.now()/1000)+10},
    {expiresAt:Math.floor(Date.now()/1000)-10},
    {expiresAt:Math.floor(Date.now()/1000)+90000}
  ]) {
    const input=fixture();
    input.domainEvidence={...input.domainEvidence,...patch};
    await blocked(input,'blocked-domain-evidence');
  }
});

test('moving Git main, substituted commit and wrong tree SHA all deny the artifact',async()=>{
  for(const update of [
    f=>{f.mainBranch.commit.sha='1'.repeat(40);},
    f=>{f.pinnedCommit.sha='1'.repeat(40);},
    f=>{f.pinnedCommit.tree.sha='1'.repeat(40);},
    f=>{f.pinnedTree.sha='not-a-tree';}
  ]) {
    const input=fixture();update(input);
    await blocked(input,'blocked-stale-source');
  }
});

test('existing redirects and case-insensitive collisions cannot be overwritten',async()=>{
  for(const path of ['public/_redirects','PUBLIC/_REDIRECTS','public/_redirects/other']) {
    const input=fixture();
    input.pinnedTree.tree.push(entry(path));
    await blocked(input,'blocked-tree-collision');
  }
});

test('symlinks, Functions, extra HTML, and wrong page modes cannot misrepresent source',async()=>{
  for(const extra of [
    entry('public/legacy.html'),entry('functions','tree'),
    entry('functions/handler.js'),entry('public/_routes.json'),
    entry('public/_worker.js'),entry('public/logo.svg','blob','120000')
  ]) {
    const input=fixture();
    input.pinnedTree.tree.push(extra);
    await blocked(input,'blocked-tree-collision');
  }
  const input=fixture();
  input.pinnedTree.tree.find(x=>x.path==='public/index.html').mode='120000';
  await blocked(input,'blocked-tree-collision');
});

test('path redirect cannot shadow homepage or send users to a missing generated route',async()=>{
  for(const pair of [
    {from:'/',to:'/about/'},{from:'/old',to:'/missing'},
    {from:'/old',to:'/api/'},{from:'/api/v1',to:'/'},
    {from:'/.well-known/health',to:'/'},
    {from:'/a/../old',to:'/'}
  ]) {
    const input=fixture();
    // For cases the opt-in planner itself refuses, it should be impossible to
    // create a stored request in the first place. The valid ones reach the
    // reviewed artifact's own stricter safety gate.
    const review=buildRedirectOptInReview({
      githubUserId:42,cloudflareAccountId:account,hostname,
      redirectConsent:true,wwwMode:'none',
      pathFrom:pair.from,pathTo:pair.to
    });
    if(review.status==='awaiting_redirect_opt_in'){
      input.storedOption=option(pair);
      await blocked(input,'blocked-unsafe-redirect');
    }else {
      assert.equal(review.status,'blocked');
    }
  }
});

test('changing a legacy path, Git SHA or owner ID changes the output digest or blocks',async()=>{
  const a=fixture(),b=fixture();
  b.storedOption=option({from:'/another-old'});
  const first=await buildStaticRedirectReviewProposal(a);
  const second=await buildStaticRedirectReviewProposal(b);
  assert.notEqual(first.proposalSha256,second.proposalSha256);
  const changed=fixture();
  changed.trustedSite.expectedBaseSha='f'.repeat(40);
  await blocked(changed,'blocked-domain-evidence');
});

test('revoked session, thrown authorization and missing verifier deny without files',async()=>{
  const disabled=fixture();disabled.assertCurrentAuthorization=async()=>false;
  await blocked(disabled,'blocked-authorization');
  const failed=fixture();failed.assertCurrentAuthorization=async()=>{throw Error('revoked');};
  await blocked(failed,'blocked-authorization');
  const missing=fixture();delete missing.assertCurrentAuthorization;
  await blocked(missing,'blocked-authorization');
});

test('mid-review mutation of the stored option, tree or domain evidence fails closed',async()=>{
  for(const field of ['storedOption','pinnedTree','domainEvidence']) {
    const input=fixture();
    let count=0;
    input.assertCurrentAuthorization=async()=>{
      if(++count===1) {
        if(field==='storedOption')input.storedOption.normalizedPayload.hostname='malicious.example.org';
        if(field==='pinnedTree')input.pinnedTree.tree.push(entry('public/_redirects'));
        if(field==='domainEvidence')input.domainEvidence.origin='https://evil.example.org';
      }
      return true;
    };
    await blocked(input,'blocked-review-context-changed');
  }
});

test('unsafe/paging-incomplete Git trees never imply complete source evidence',async()=>{
  for(const modify of [
    t=>{t.truncated=true;},
    t=>{t.tree=[];},
    t=>{t.tree.push({...entry('public/index.html'),path:'PUBLIC/INDEX.HTML'});},
    t=>{t.tree.find(x=>x.path==='public').mode='100644';},
    t=>{t.tree.find(x=>x.path==='public/index.html').sha='not-a-sha';}
  ]) {
    const input=fixture();modify(input.pinnedTree);
    await blocked(input,'blocked-tree-collision');
  }
});
