import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizeSite,renderSite} from '../site/render-site.mjs';
import {MANAGED_CONFIG_PATH,planManagedSiteSidecarMigration,
  planManagedSiteStructuredEdit} from './managed-site-config.mjs';
import {ManagedTreePreflightError,preflightManagedSiteUpdateTree}
  from './managed-site-tree-preflight.mjs';

const sha = input => createHash('sha256').update(input,'utf8').digest('hex');
const mainSha='a'.repeat(40);
const homepageBlob='b'.repeat(40);
const treeSha='c'.repeat(40);
const sidecarBlob='d'.repeat(40);
const siteId='managed_42_immutable-project';
const site=normalizeSite({name:'Willow Studio',tagline:'Launch homepage',
  about:'Meet our design team',services:['Portraits','Design'],
  theme:'forest',contactEmail:'hello@willow.example'});
const html=renderSite(site);
const eligibility=source=>({siteId:source.siteId,baseCommitSha:source.baseCommitSha,
  homepageGitBlobSha:source.homepageGitBlobSha,sourceKind:'generated',
  layout:'one-page',provenance:'pinned_launch_approval'});
const approved=async ()=>true;
const source=(options={})=>({
  status:'github_current_source_verified',siteId,baseCommitSha:mainSha,
  homepageGitBlobSha:homepageBlob,homepageHtmlSha256:sha(html),
  publicationVerified:false,editMode:'approved_migration_required',html,...options
});
const migrationEvidence=()=>({path:MANAGED_CONFIG_PATH,siteId,
  refCommitSha:mainSha,exists:false});
const entry=(path,mode,type,hash)=>({path,mode,type,sha:hash});
const baseRows=()=>[
  entry('README.md','100644','blob','e'.repeat(40)),
  entry('public','040000','tree','1'.repeat(40)),
  entry('public/index.html','100644','blob',homepageBlob)
];
const branch=()=>({name:'main',commit:{sha:mainSha}});
const commit=()=>({sha:mainSha,tree:{sha:treeSha}});
const tree=rows=>({sha:treeSha,truncated:false,tree:rows});

async function fixture(kind='migration') {
  const currentSource=source();
  let sidecarEvidence,reviewPlan,rows=baseRows();
  if(kind==='migration'){
    sidecarEvidence=migrationEvidence();
    reviewPlan=await planManagedSiteSidecarMigration({
      currentSource,sidecarEvidence,candidateSite:site,
      eligibilityEvidence:eligibility(currentSource),
      assertGeneratedOnePageEligibility:approved
    });
  } else {
    const init=await fixture('migration');
    const sidecarRaw=init.reviewPlan.files[0].content;
    sidecarEvidence={path:MANAGED_CONFIG_PATH,siteId,
      refCommitSha:mainSha,exists:true,
      blobSha:sidecarBlob,contentSha256:sha(sidecarRaw)};
    reviewPlan=await planManagedSiteStructuredEdit({
      currentSource,sidecarEvidence,sidecarRaw,
      patch:{tagline:'A customer-approved newer tagline'},
      eligibilityEvidence:eligibility(currentSource),
      assertGeneratedOnePageEligibility:approved
    });
    rows.push(entry('.launch-and-own','040000','tree','2'.repeat(40)));
    rows.push(entry(MANAGED_CONFIG_PATH,'100644','blob',sidecarBlob));
  }
  return {currentSource,sidecarEvidence,reviewPlan,
    mainBranch:branch(),pinnedCommit:commit(),pinnedTree:tree(rows),
    trustedReviewDigest:reviewPlan.approvalReviewDigest};
}
const rejects=expected=>error=>{
  assert(error instanceof ManagedTreePreflightError);
  assert.equal(error.code,expected);
  assert(!error.message.includes('hello@willow.example'));
  return true;
};

test('sidecar migration checks current main tree and proposes only creating a private config file',async()=>{
  const f=await fixture('migration');
  const result=await preflightManagedSiteUpdateTree(f);
  assert.equal(result.status,'tree_review_preflight_passed');
  assert.equal(result.siteId,siteId);
  assert.equal(result.expectedBaseCommitSha,mainSha);
  assert.equal(result.expectedTreeSha,treeSha);
  assert.equal(result.reviewDigest,f.trustedReviewDigest);
  assert.deepEqual(result.proposedPaths,[MANAGED_CONFIG_PATH]);
  assert.equal(result.readyForProviderWrite,false);
  assert.equal(result.requiresSeparateHumanApproval,true);
  assert.equal(result.publicationVerified,false);
  assert.equal(result.fileModesChecked,true);
  assert(Object.isFrozen(result));
  assert(!JSON.stringify(result).includes('hello@willow.example'));
  assert(!JSON.stringify(result).includes(html));
});

test('reviewed edit checks both pinned regular Git blobs and only two expected file replacements',async()=>{
  const f=await fixture('edit');
  const result=await preflightManagedSiteUpdateTree(f);
  assert.deepEqual(result.proposedPaths,['public/index.html',MANAGED_CONFIG_PATH]);
  assert.equal(result.expectedBaseCommitSha,mainSha);
  assert.equal(result.readyForProviderWrite,false);
});

test('migration allows existing ordinary private sidecar parent folder but never an existing file',async()=>{
  const f=await fixture();
  f.pinnedTree.tree.push(entry('.launch-and-own','040000','tree','2'.repeat(40)));
  f.pinnedTree.tree.push(entry('.launch-and-own/README.md','100644','blob','e'.repeat(40)));
  assert.equal((await preflightManagedSiteUpdateTree(f)).status,'tree_review_preflight_passed');
  f.pinnedTree.tree.push(entry(MANAGED_CONFIG_PATH,'100644','blob',sidecarBlob));
  await assert.rejects(preflightManagedSiteUpdateTree(f),rejects('target_path_collision'));
});

test('refuses a symlink or submodule at either target file',async()=>{
  for(const kind of ['migration','edit']){
    for(const mode of ['120000','160000','040000']){
      const f=await fixture(kind);
      const row=f.pinnedTree.tree.find(x=>x.path==='public/index.html');
      row.mode=mode;
      row.type=mode==='160000'?'commit':mode==='040000'?'tree':'blob';
      await assert.rejects(preflightManagedSiteUpdateTree(f),
        rejects('expected_regular_file_missing_or_replaced'));
    }
  }
});

test('refuses symlink, submodule or regular file as parent for targets',async()=>{
  for(const parentPath of ['public','.launch-and-own']){
    for(const [mode,type] of [['120000','blob'],['160000','commit'],['100644','blob']]){
      const f=await fixture('edit');
      const row=f.pinnedTree.tree.find(x=>x.path===parentPath);
      row.mode=mode;row.type=type;
      await assert.rejects(preflightManagedSiteUpdateTree(f),
        rejects('target_parent_is_not_directory'));
    }
  }
});

test('refuses missing public directory, missing or changed homepage regular blob',async()=>{
  for(const path of ['public','public/index.html']){
    const f=await fixture('migration');
    f.pinnedTree.tree=f.pinnedTree.tree.filter(e=>e.path!==path);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects(path==='public'?'expected_directory_missing_or_replaced':
        'expected_regular_file_missing_or_replaced'));
  }
  const f=await fixture('edit');
  f.pinnedTree.tree.find(e=>e.path==='public/index.html').sha='9'.repeat(40);
  await assert.rejects(preflightManagedSiteUpdateTree(f),rejects('expected_file_blob_changed'));
});

test('requires current sidecar at exact Git blob in reviewed paired edit',async()=>{
  const f=await fixture('edit');
  f.pinnedTree.tree.find(e=>e.path===MANAGED_CONFIG_PATH).sha='9'.repeat(40);
  await assert.rejects(preflightManagedSiteUpdateTree(f),rejects('expected_file_blob_changed'));
  f.pinnedTree.tree=f.pinnedTree.tree.filter(e=>e.path!==MANAGED_CONFIG_PATH);
  await assert.rejects(preflightManagedSiteUpdateTree(f),
    rejects('expected_regular_file_missing_or_replaced'));
});

test('missing .launch-and-own parent with descendant or directory collision is denied',async()=>{
  const f=await fixture('edit');
  f.pinnedTree.tree=f.pinnedTree.tree.filter(e=>e.path!=='.launch-and-own');
  await assert.rejects(preflightManagedSiteUpdateTree(f),
    rejects('expected_directory_missing_or_replaced'));
  const g=await fixture('migration');
  g.pinnedTree.tree.push(entry('.launch-and-own/site-config.json/other',
    '100644','blob','f'.repeat(40)));
  await assert.rejects(preflightManagedSiteUpdateTree(g),
    rejects('expected_directory_missing_or_replaced'));
});

test('incomplete, missing and oversize Git tree responses fail closed',async()=>{
  for(const bad of [
    t=>{t.truncated=true;},
    t=>{delete t.truncated;},
    t=>{t.tree=[];},
    t=>{t.tree=undefined;},
    t=>{t.tree.push(...Array.from({length:4100},(_,i)=>entry(
      'unrelated-'+i,'100644','blob','e'.repeat(40))));}
  ]){
    const f=await fixture();bad(f.pinnedTree);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects('incomplete_or_oversized_tree'));
  }
});

test('duplicates and Git-invalid paths or unknown git entry modes fail closed',async()=>{
  for(const bad of [
    t=>{t.tree.push({...t.tree[0]});},
    t=>{t.tree[0].path='../outside';},
    t=>{t.tree[0].path='public//bad';},
    t=>{t.tree[0].path='public\\test';},
    t=>{t.tree[0].path='x\u0000y';},
    t=>{t.tree[0].path='';},
    t=>{t.tree[0].sha='not-a-sha';},
    t=>{t.tree[0].mode='100664';},
    t=>{t.tree[0].type='commit';}
  ]){
    const f=await fixture();bad(f.pinnedTree);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects('unverifiable_tree_entry'));
  }
});

test('main commit, branch SHA and tree must match the exact approved base',async()=>{
  for(const bad of [
    f=>{f.mainBranch.name='development';},
    f=>{f.mainBranch.commit.sha='f'.repeat(40);},
    f=>{f.pinnedCommit.sha='f'.repeat(40);},
    f=>{f.pinnedCommit.tree.sha='f'.repeat(40);},
    f=>{f.pinnedTree.sha='f'.repeat(40);}
  ]){
    const f=await fixture();bad(f);
    await assert.rejects(preflightManagedSiteUpdateTree(f),rejects('stale_main_or_tree'));
  }
});

test('cannot substitute sidecar evidence from another site, commit, or blob',async()=>{
  for(const bad of [
    e=>{e.siteId='managed_43_other-project';},
    e=>{e.refCommitSha='f'.repeat(40);},
    e=>{e.path='public/index.html';}
  ]){
    const f=await fixture('edit');bad(f.sidecarEvidence);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects('sidecar_proof_does_not_match_source'));
  }
  for(const bad of [
    e=>{e.blobSha='f'.repeat(40);},
    e=>{e.contentSha256='f'.repeat(64);}
  ]){
    const f=await fixture('edit');bad(f.sidecarEvidence);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects('sidecar_proof_does_not_match_review'));
  }
});

test('sidecar-only migration cannot overwrite or pretend an existing sidecar is absent',async()=>{
  const f=await fixture('migration');
  f.sidecarEvidence.exists=true;
  await assert.rejects(preflightManagedSiteUpdateTree(f),
    rejects('sidecar_proof_does_not_match_review'));
  f.sidecarEvidence.exists=false;
  f.sidecarEvidence.blobSha=sidecarBlob;
  await assert.rejects(preflightManagedSiteUpdateTree(f),
    rejects('sidecar_proof_does_not_match_review'));
});

test('reviewed output must be review-only and fixed file paths, never arbitrary repository writes',async()=>{
  const variants=[
    p=>{p.readyForProviderWrite=true;},
    p=>{p.requiresSeparateHumanApproval=false;},
    p=>{p.status='approved';},
    p=>{p.publicationVerified=true;},
    p=>{p.files.push({path:'.github/workflows/attack.yml',action:'create',content:'a'});},
    p=>{p.files[0].path='README.md';},
    p=>{p.files[0].action='delete';},
    p=>{p.files[0].content='';}
  ];
  for(const bad of variants){
    const f=await fixture('edit');bad(f.reviewPlan);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects(variants.indexOf(bad)<=3?'trusted_review_does_not_match_source':
        'unexpected_review_file_set'));
  }
});

test('client-provided review digest without authenticated server match does not unlock write',async()=>{
  for(const bad of [undefined,'e'.repeat(64),'x'.repeat(64)]){
    const f=await fixture('migration');
    f.trustedReviewDigest=bad;
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects(bad===undefined||bad[0]==='x'?'trusted_review_digest_required':
        'trusted_review_does_not_match_source'));
  }
});

test('proposed sidecar and homepage SHA-256 must match actual exact UTF-8 files',async()=>{
  const migration=await fixture();
  migration.reviewPlan.files[0].content+='\n';
  await assert.rejects(preflightManagedSiteUpdateTree(migration),
    rejects('proposed_sidecar_digest_mismatch'));
  const edit=await fixture('edit');
  edit.reviewPlan.files[0].content=edit.reviewPlan.files[0].content.replace(
    'A customer-approved newer tagline','Changed without approval');
  await assert.rejects(preflightManagedSiteUpdateTree(edit),
    rejects('proposed_homepage_digest_mismatch'));
  const other=await fixture('edit');
  other.reviewPlan.files[1].content+='\n';
  await assert.rejects(preflightManagedSiteUpdateTree(other),
    rejects('proposed_sidecar_digest_mismatch'));
});

test('mismatch between current source and approved plan is refused before hashing',async()=>{
  for(const bad of [
    f=>{f.currentSource.baseCommitSha='e'.repeat(40);},
    f=>{f.reviewPlan.source.siteId='managed_53_other-site';},
    f=>{f.reviewPlan.source.existingHomepageGitBlobSha='e'.repeat(40);},
    f=>{f.reviewPlan.source.existingHtmlSha256='e'.repeat(64);}
  ]){
    const f=await fixture('migration');bad(f);
    await assert.rejects(preflightManagedSiteUpdateTree(f),
      rejects(bad.toString().includes('baseCommitSha')?'trusted_review_does_not_match_source':
        'trusted_review_does_not_match_source'));
  }
});

test('mutation of review or tree during async hashing is rejected even after snapshot',async()=>{
  for(const mutate of [
    f=>{f.reviewPlan.files[0].content+='changed';},
    f=>{f.pinnedTree.tree[0].sha='f'.repeat(40);},
    f=>{f.sidecarEvidence.siteId='managed_9_another';},
    f=>{f.trustedReviewDigest='f'.repeat(64);}
  ]){
    const f=await fixture('edit');
    const pending=preflightManagedSiteUpdateTree(f);
    mutate(f);
    await assert.rejects(pending,rejects('trusted_evidence_changed'));
  }
});

test('no real GitHub/Cloudflare calls, customer publication or authorization claims',async()=>{
  const result=await preflightManagedSiteUpdateTree(await fixture('edit'));
  assert.equal(result.readyForProviderWrite,false);
  assert.equal(result.publicationVerified,false);
  assert.equal(result.requiresSeparateHumanApproval,true);
  assert(!Object.hasOwn(result,'approved'));
  assert(!Object.hasOwn(result,'pullRequest'));
  assert(!Object.hasOwn(result,'providerAccessToken'));
});
