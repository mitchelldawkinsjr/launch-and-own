import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderSite} from '../site/render-site.mjs';
import {buildReviewedHomepageRevert,HomepageRevertReviewError} from './reviewed-homepage-revert.mjs';

const MAIN='a'.repeat(40);
const PARENT='b'.repeat(40);
const TREE_NOW='c'.repeat(40);
const TREE_OLD='d'.repeat(40);
const BLOB=x=>{
  const b=Buffer.from(x,'utf8');
  return createHash('sha1').update('blob '+b.byteLength+'\0').update(b).digest('hex');
};
const SHA256=x=>createHash('sha256').update(x,'utf8').digest('hex');
const business={
  name:'Willow & Co',tagline:'Friendly portraits',about:'Local photography for families.',
  services:['Family portraits'],theme:'ocean',contactEmail:'hello@willow.example'
};
const previousHtml=renderSite(business);
const currentHtml=renderSite({...business,tagline:'New update to restore'});
const entry=(path,mode,type,sha)=>({path,mode,type,sha});
const trueGate=async()=>true;
function fixture() {
  const current=[
    entry('README.md','100644','blob','1'.repeat(40)),
    entry('public','040000','tree','2'.repeat(40)),
    entry('public/_headers','100644','blob','3'.repeat(40)),
    entry('public/index.html','100644','blob',BLOB(currentHtml))
  ];
  const parent=[
    entry('README.md','100644','blob','1'.repeat(40)),
    entry('public','040000','tree','4'.repeat(40)),
    entry('public/_headers','100644','blob','3'.repeat(40)),
    entry('public/index.html','100644','blob',BLOB(previousHtml))
  ];
  return {
    trustedSite:{
      githubUserId:42,githubRepositoryId:1001,
      cloudflareAccountId:'1'.repeat(32),
      pagesProjectId:'pages-123',pagesProjectName:'esp-willow-site',
      expectedMainSha:MAIN,branch:'main'
    },
    sourceKind:'generated-one-page',
    currentBranch:{name:'main',commit:{sha:MAIN}},
    currentCommit:{sha:MAIN,parents:[{sha:PARENT}],tree:{sha:TREE_NOW}},
    parentCommit:{sha:PARENT,tree:{sha:TREE_OLD}},
    currentTree:{sha:TREE_NOW,truncated:false,tree:current},
    parentTree:{sha:TREE_OLD,truncated:false,tree:parent},
    currentHomepage:{path:'public/index.html',content:currentHtml,gitBlobSha:BLOB(currentHtml)},
    parentHomepage:{path:'public/index.html',content:previousHtml,gitBlobSha:BLOB(previousHtml)},
    assertCurrentAuthorization:trueGate,
    assertGeneratedOnePageEligibility:trueGate
  };
}
const plan=x=>buildReviewedHomepageRevert(x);
const blocked=(promise,code)=>assert.rejects(promise,e=>
  e instanceof HomepageRevertReviewError && e.code===code);

test('reviewed revert binds current main, direct parent and exact restored HTML to an immutable digest',async()=>{
  const x=fixture();
  const result=await plan(x);
  assert.equal(result.status,'review_required');
  assert.equal(result.kind,'restore_previous_homepage_via_git_pr');
  assert.equal(result.source.expectedMainSha,MAIN);
  assert.equal(result.source.restoreFromCommitSha,PARENT);
  assert.equal(result.source.githubRepositoryId,1001);
  assert.equal(result.files.length,1);
  assert.equal(result.files[0].content,previousHtml);
  assert.equal(result.files[0].beforeSha256,SHA256(currentHtml));
  assert.equal(result.files[0].afterSha256,SHA256(previousHtml));
  assert.equal(result.files[0].expectedGitBlobSha,BLOB(currentHtml));
  assert.match(result.approvalReviewDigest,/^[a-f0-9]{64}$/);
  assert.equal(result.readyForProviderWrite,false);
  assert.equal(result.publicationVerified,false);
  assert.equal(result.previousDeploymentRestored,false);
  assert.equal(result.previewProtectionVerified,false);
  assert.equal(result.requiresSeparateOwnerApproval,true);
  assert.equal(result.requiresSameRepositoryPr,true);
  assert.equal(result.requiresManualMerge,true);
  assert.equal(result.requiresIndependentPostMergeVerification,true);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.source));
  assert(Object.isFrozen(result.files));
  assert(Object.isFrozen(result.files[0]));
  assert.deepEqual(result,await plan(fixture()));
});

test('changing site identity changes review digest and requires authoritative authorization fence',async()=>{
  const base=await plan(fixture());
  const changed=fixture();changed.trustedSite.githubRepositoryId=1002;
  changed.assertCurrentAuthorization=async ctx=>ctx.githubRepositoryId===1001;
  await blocked(plan(changed),'authorization_or_provenance_revoked');
  const allowDifferent=fixture();allowDifferent.trustedSite.githubRepositoryId=1002;
  const reviewed=await plan(allowDifferent);
  assert.notEqual(base.approvalReviewDigest,reviewed.approvalReviewDigest);
});

test('reject revoked or absent live authorization or generated-page provenance',async()=>{
  const a=fixture();delete a.assertCurrentAuthorization;
  await blocked(plan(a),'live_authorization_and_provenance_required');
  const b=fixture();b.assertCurrentAuthorization=async()=>false;
  await blocked(plan(b),'authorization_or_provenance_revoked');
  const c=fixture();c.assertGeneratedOnePageEligibility=async()=>false;
  await blocked(plan(c),'authorization_or_provenance_revoked');
  const d=fixture();d.assertGeneratedOnePageEligibility=async()=>{throw Error('grant revoked');};
  await blocked(plan(d),'authorization_or_provenance_revoked');
});

test('re-checks live auth and provenance after async hashing, rejects revoked grant',async()=>{
  const x=fixture();
  let auth=0,source=0;
  x.assertCurrentAuthorization=async()=>++auth===1;
  x.assertGeneratedOnePageEligibility=async()=>{source++;return true;};
  await blocked(plan(x),'authorization_or_provenance_revoked');
  assert.equal(auth,2);assert.equal(source,1);
});

test('rejects stale branch, unrelated parent, merge commit and wrong tree',async()=>{
  const a=fixture();a.currentBranch.commit.sha=PARENT;
  await blocked(plan(a),'stale_or_unsupported_commit_chain');
  const b=fixture();b.currentCommit.parents=[{sha:PARENT},{sha:'e'.repeat(40)}];
  await blocked(plan(b),'stale_or_unsupported_commit_chain');
  const c=fixture();c.parentCommit.sha='f'.repeat(40);
  await blocked(plan(c),'stale_or_unsupported_commit_chain');
  const d=fixture();d.parentTree.sha='f'.repeat(40);
  await blocked(plan(d),'stale_or_unsupported_commit_chain');
});

test('rejects edits to README, headers, or extra unrelated file',async()=>{
  const a=fixture();a.currentTree.tree.find(f=>f.path==='README.md').sha='e'.repeat(40);
  await blocked(plan(a),'other_files_changed');
  const b=fixture();b.parentTree.tree.find(f=>f.path==='public/_headers').sha='f'.repeat(40);
  await blocked(plan(b),'other_files_changed');
  const c=fixture();c.currentTree.tree.push(entry('public/image.png','100644','blob','5'.repeat(40)));
  await blocked(plan(c),'other_files_changed');
});

test('rejects generated sidecars and multi-page/custom HTML',async()=>{
  const a=fixture();a.currentTree.tree.push(entry('.launch-and-own/site-config.json','100644','blob','5'.repeat(40)));
  await blocked(plan(a),'managed_sidecar_requires_coordinated_update');
  const b=fixture();b.parentTree.tree.push(entry('public/about/index.html','100644','blob','5'.repeat(40)));
  await blocked(plan(b),'other_html_requires_multi_page_review');
  const c=fixture();c.sourceKind='uploaded-zip';
  await blocked(plan(c),'only_generated_one_page_supported');
  const d=fixture();d.sourceKind='generated-multi-page';
  await blocked(plan(d),'only_generated_one_page_supported');
});

test('rejects symlinked homepage, changed case, and missing parent directory',async()=>{
  const a=fixture();a.currentTree.tree.find(f=>f.path==='public/index.html').mode='120000';
  await blocked(plan(a),'homepage_not_regular_file');
  const b=fixture();b.parentTree.tree.find(f=>f.path==='public/index.html').path='PUBLIC/index.html';
  await blocked(plan(b),'homepage_not_regular_file');
  const c=fixture();c.currentTree.tree=c.currentTree.tree.filter(f=>f.path!=='public');
  await blocked(plan(c),'homepage_not_regular_file');
});

test('rejects truncated tree, duplicate case folded paths and traversal',async()=>{
  const a=fixture();a.parentTree.truncated=true;
  await blocked(plan(a),'unverifiable_git_tree');
  const b=fixture();b.currentTree.tree.push(entry('PUBLIC/INDEX.HTML','100644','blob','5'.repeat(40)));
  await blocked(plan(b),'invalid_or_duplicate_tree_entry');
  const c=fixture();c.parentTree.tree.push(entry('public/../secret','100644','blob','5'.repeat(40)));
  await blocked(plan(c),'invalid_or_duplicate_tree_entry');
});

test('rejects mismatched current or previous Git blob bytes and oversized pages',async()=>{
  const a=fixture();a.currentHomepage.content+='<!-- changed -->';
  await blocked(plan(a),'homepage_blob_does_not_match_git_tree');
  const b=fixture();b.parentHomepage.gitBlobSha='f'.repeat(40);
  await blocked(plan(b),'homepage_blob_does_not_match_git_tree');
  const c=fixture();c.parentHomepage.content='x'.repeat(128*1024+1);
  await blocked(plan(c),'exact_pinned_homepage_required');
});

test('rejects no-op restore of identical source',async()=>{
  const a=fixture();
  a.parentTree.tree.find(f=>f.path==='public/index.html').sha=BLOB(currentHtml);
  await blocked(plan(a),'no_homepage_change_to_revert');
});

test('detects evidence modification during async rechecks',async()=>{
  const a=fixture();let count=0;
  a.assertCurrentAuthorization=async()=>{
    if(++count===2) a.trustedSite.githubRepositoryId=2020;
    return true;
  };
  await blocked(plan(a),'evidence_changed_during_review');
  assert.equal(count,2);
});

test('explicit current provenance callback receives the immutable selected owner/target and revision',async()=>{
  const a=fixture();let authChecks=0,eligibilityChecks=0;
  a.assertCurrentAuthorization=async ctx=>{
    authChecks++;assert.equal(ctx.githubUserId,42);
    assert.equal(ctx.githubRepositoryId,1001);
    assert.equal(ctx.expectedMainSha,MAIN);
    assert.equal(ctx.restoreFromCommitSha,PARENT);
    assert.equal(ctx.sourceKind,'generated-one-page');
    assert(Object.isFrozen(ctx));
    return true;
  };
  a.assertGeneratedOnePageEligibility=async ctx=>{
    eligibilityChecks++;return ctx.githubRepositoryId===1001;
  };
  await plan(a);
  assert.equal(authChecks,2);
  assert.equal(eligibilityChecks,2);
});
