import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderSite} from './render-site.mjs';
import {renderSiteBundle} from './render-site-bundle.mjs';
import {buildSeoReviewProposal} from './seo-review-proposal.mjs';
import {preflightApprovedSeoGitChange,SeoGitPreflightError} from './seo-git-preflight.mjs';

const baseSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const site = {
  name:'Willow & Co',tagline:'Portraits and celebrations',
  about:'Photography for families in our community.',
  services:['Portraits','Events'],theme:'forest',
  contactEmail:'hello@willow.example'
};
const trustedSite = {
  githubUserId:42,githubRepositoryId:1001,
  cloudflareAccountId:'1'.repeat(32),pagesProjectId:'pages-project-123',
  pagesProjectName:'esp-willow-site',expectedBaseSha:baseSha,branch:'main'
};
const digest = s => createHash('sha256').update(s).digest('hex');
const gitBlob = s => {
  const b = Buffer.from(s,'utf8');
  return createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
};
const entry = (path,mode,type,sha=baseSha) => ({path,mode,type,sha});
const permit = async () => true;
const denyCode = async (promise,code) => {
  await assert.rejects(promise,e => e instanceof SeoGitPreflightError && e.code === code);
};

async function fixture(kind='generated-one-page') {
  const domainEvidence = {
    kind:'verified-owned-domain',origin:'https://willow.example',
    githubUserId:trustedSite.githubUserId,
    githubRepositoryId:trustedSite.githubRepositoryId,
    cloudflareAccountId:trustedSite.cloudflareAccountId,
    pagesProjectId:trustedSite.pagesProjectId,
    pagesProjectName:trustedSite.pagesProjectName,
    sourceSha:baseSha,checkedAt:Math.floor(Date.now()/1000)-10,
    expiresAt:Math.floor(Date.now()/1000)+3600
  };
  const pages = kind === 'generated-one-page'
    ? [{path:'public/index.html',html:renderSite(site)}]
    : renderSiteBundle({...site,layout:'multi-page'}).pages;
  const dirs = new Set(['public']);
  for (const page of pages) {
    const pathParts=page.path.split('/');
    for (let i=2;i<pathParts.length;i++) dirs.add(pathParts.slice(0,i).join('/'));
  }
  const tree = [
    ...[...dirs].map(path=>entry(path,'040000','tree')),
    ...pages.map(p=>entry(p.path,'100644','blob',gitBlob(p.html)))
  ];
  const pinnedFiles = pages.map(p=>({
    path:p.path,content:p.html,gitBlobSha:gitBlob(p.html)
  }));
  const reviewProposal = await buildSeoReviewProposal({
    site,sourceKind:kind,trustedSite,domainEvidence,
    existingPaths:pages.map(p=>p.path)
  });
  assert.equal(reviewProposal.status,'review-required');
  return {
    site:{...site},sourceKind:kind,trustedSite:{...trustedSite},
    domainEvidence,approvedProposalSha256:reviewProposal.proposalSha256,
    reviewProposal,mainBranch:{name:'main',commit:{sha:baseSha}},
    pinnedCommit:{sha:baseSha,tree:{sha:treeSha}},
    pinnedTree:{sha:treeSha,truncated:false,tree},
    pinnedFiles,assertCurrentAuthorization:permit
  };
}
const run = v => preflightApprovedSeoGitChange(v);

test('verified one-page preflight binds reviewed bytes, live repo/blob and owner approval, without writes',async()=>{
  const result=await run(await fixture());
  assert.equal(result.status,'verified-seo-review-preflight');
  assert.equal(result.files.length,3);
  assert.equal(result.files[0].action,'review-replace');
  assert.equal(result.files[1].action,'review-create');
  assert.equal(result.files[2].action,'review-create');
  assert.match(result.files[0].content,/rel="canonical"/);
  assert.equal(result.files[0].expectedGitBlobSha,
    gitBlob(renderSite(site)));
  assert.equal(result.ownerApprovalMatched,true);
  assert.equal(result.readyForProviderWrite,false);
  assert.equal(result.publicationVerified,false);
  assert.equal(result.requiresManualMerge,true);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.files));
  assert(result.files.every(Object.isFrozen));
});

test('verified four-page preflight checks all four original Git blobs',async()=>{
  const result=await run(await fixture('generated-multi-page'));
  assert.equal(result.files.length,6);
  const routes=['/','/about/','/services/','/contact/'];
  for(let i=0;i<4;i++)
    assert(result.files[i].content.includes(
      'rel="canonical" href="https://willow.example'+routes[i]+'"'));
  assert.equal(result.files[5].content.match(/<loc>/g).length,4);
});

test('separate approval digest cannot be inferred from proposal payload',async()=>{
  const x=await fixture();x.approvedProposalSha256='0'.repeat(64);
  await denyCode(run(x),'separate_owner_approval_required');
  const y=await fixture();y.reviewProposal={...y.reviewProposal,files:[...y.reviewProposal.files]};
  y.reviewProposal.files[0]={...y.reviewProposal.files[0],content:'tampered'};
  await denyCode(run(y),'proposed_bytes_changed');
});

test('wrong tenant, wrong site or changed origin fails closed',async()=>{
  const x=await fixture();x.trustedSite.githubRepositoryId=999;
  await denyCode(run(x),'domain_owner_mismatch');
  const y=await fixture();y.trustedSite.cloudflareAccountId='f'.repeat(32);
  await denyCode(run(y),'domain_owner_mismatch');
  const z=await fixture();z.domainEvidence.origin='https://changed.example';
  await denyCode(run(z),'proposal_stale_or_unverifiable');
});

test('revoked, missing or false authorization cannot pass either fence',async()=>{
  const x=await fixture();delete x.assertCurrentAuthorization;
  await denyCode(run(x),'authorization_callback_required');
  const y=await fixture();y.assertCurrentAuthorization=async()=>false;
  await denyCode(run(y),'owner_authorization_revoked');
  const z=await fixture();let checks=0;
  z.assertCurrentAuthorization=async()=>++checks===1;
  await denyCode(run(z),'owner_authorization_revoked');
  assert.equal(checks,2);
});

test('stale main and tree or truncated tree rejects unverified Git evidence',async()=>{
  const x=await fixture();x.mainBranch.commit.sha='c'.repeat(40);
  await denyCode(run(x),'stale_main_or_tree');
  const y=await fixture();y.pinnedCommit.tree.sha='d'.repeat(40);
  await denyCode(run(y),'stale_main_or_tree');
  const z=await fixture();z.pinnedTree.truncated=true;
  await denyCode(run(z),'incomplete_git_tree');
});

test('reject symlinks, case collisions and missing directories',async()=>{
  const x=await fixture();x.pinnedTree.tree.find(t=>t.path==='public/index.html').mode='120000';
  await denyCode(run(x),'original_page_not_regular_file');
  const y=await fixture();y.pinnedTree.tree.push(entry('PUBLIC/INDEX.HTML','100644','blob'));
  await denyCode(run(y),'invalid_or_duplicate_tree_entry');
  const z=await fixture();z.pinnedTree.tree=z.pinnedTree.tree.filter(t=>t.path!=='public');
  await denyCode(run(z),'target_parent_not_directory');
});

test('reject existing SEO control files and unexpected custom public HTML',async()=>{
  const x=await fixture();
  x.pinnedTree.tree.push(entry('public/robots.txt','100644','blob'));
  await denyCode(run(x),'seo_control_file_collision');
  const y=await fixture();
  y.pinnedTree.tree.push(entry('public/extra.html','100644','blob'));
  await denyCode(run(y),'unexpected_unreviewed_html');
});

test('reject real GitHub page edits even when caller claims a matching SHA',async()=>{
  const x=await fixture();
  x.pinnedFiles[0].content=x.pinnedFiles[0].content+'<!-- change -->';
  await denyCode(run(x),'source_bytes_or_git_blob_mismatch');
  const y=await fixture();
  y.pinnedFiles[0].content=y.pinnedFiles[0].content+'<!-- committed change -->';
  const newBlob=gitBlob(y.pinnedFiles[0].content);
  y.pinnedFiles[0].gitBlobSha=newBlob;
  y.pinnedTree.tree.find(t=>t.path==='public/index.html').sha=newBlob;
  await denyCode(run(y),'source_bytes_or_git_blob_mismatch');
});

test('changing owner/site/approval while verification is in flight is rejected',async()=>{
  const x=await fixture();
  let calls=0;
  x.assertCurrentAuthorization=async()=>{
    if (++calls===2) x.trustedSite.githubUserId=55;
    return true;
  };
  await denyCode(run(x),'evidence_changed_during_review');
  assert.equal(calls,2);
});

test('ZIP/custom sites do not get an automatic SEO Git change plan',async()=>{
  const x=await fixture();x.sourceKind='uploaded-zip';
  await denyCode(run(x),'unsupported_source_kind');
});

test('one-page generated site cannot suppress an existing second HTML route',async()=>{
  const x=await fixture();
  x.pinnedTree.tree.push(entry('public/about','040000','tree'));
  x.pinnedTree.tree.push(entry('public/about/index.html','100644','blob'));
  await denyCode(run(x),'unexpected_unreviewed_html');
});
