import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderSite} from './render-site.mjs';
import {buildSeoReviewProposal} from './seo-review-proposal.mjs';

const sha = 'a'.repeat(40);
const site = Object.freeze({
  name:'Willow & Co',tagline:'Beautiful portraits for our neighbors',
  about:'Portrait photography, portraits & family celebrations.',
  services:['Family portraits','Events'],theme:'forest',contactEmail:'hello@willow.example'
});
const trustedSite = Object.freeze({
  githubUserId:42,githubRepositoryId:1001,
  cloudflareAccountId:'1'.repeat(32),pagesProjectId:'pages-id-123',
  pagesProjectName:'esp-willow-site',expectedBaseSha:sha,branch:'main'
});
const now = Math.floor(Date.now()/1000);
const domainEvidence = Object.freeze({
  kind:'verified-owned-domain',origin:'https://willow.example',
  githubUserId:42,githubRepositoryId:1001,
  cloudflareAccountId:'1'.repeat(32),pagesProjectId:'pages-id-123',
  pagesProjectName:'esp-willow-site',sourceSha:sha,
  checkedAt:now-60,expiresAt:now+3600
});
const input = {sourceKind:'generated-one-page',site,trustedSite,domainEvidence};
const proposal = updates=>buildSeoReviewProposal({...input,...updates});
const digest = text=>createHash('sha256').update(text).digest('hex');

test('single generated site: deterministic exact proposed HTML and robots/sitemap',async()=>{
 const result = await proposal();
 assert.equal(result.status,'review-required');
 assert.equal(result.canonicalOrigin,'https://willow.example');
 assert.equal(result.publicationVerified,false);
 assert.equal(result.requiresOwnerApproval,true);
 assert.equal(result.files.length,3);
 assert.deepEqual(result.files.map(f=>f.path),
  ['public/index.html','public/robots.txt','public/sitemap.xml']);
 const [home,robots,sitemap]=result.files;
 assert.equal(home.action,'review-update');
 assert.equal(home.beforeSha256,digest(renderSite(site)));
 assert.equal(home.afterSha256,digest(home.content));
 assert.equal(robots.action,'review-create');
 assert.equal(sitemap.action,'review-create');
 assert.equal(robots.beforeSha256,null);
 assert.match(home.content,/<title>Willow &amp; Co \| Welcome<\/title>/);
 assert.match(home.content,/<meta name="description"/);
 assert.match(home.content,/<meta property="og:title" content="Willow &amp; Co \| Welcome">/);
 assert.match(home.content,/<meta property="og:description"/);
 assert.match(home.content,/<meta property="og:type" content="website">/);
 assert.match(home.content,/<link rel="canonical" href="https:\/\/willow\.example\/">/);
 assert.match(home.content,/<meta property="og:url" content="https:\/\/willow\.example\/">/);
 assert.match(home.content,/<meta name="twitter:card" content="summary">/);
 assert.equal((home.content.match(/rel="canonical"/g)||[]).length,1);
 assert.equal(robots.content,'User-agent: *\nAllow: /\nSitemap: https://willow.example/sitemap.xml\n');
 assert.match(sitemap.content,/<loc>https:\/\/willow\.example\/<\/loc>/);
 assert.equal((sitemap.content.match(/<loc>/g)||[]).length,1);
 assert(!sitemap.content.includes('pages.dev'));
 assert.match(result.proposalSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(result,await proposal());
 assert(Object.isFrozen(result.files));
 assert(result.files.every(Object.isFrozen));
});

test('four-page bundle: correct clean-route canonical URL on all pages',async()=>{
 const result=await proposal({sourceKind:'generated-multi-page',site:{...site,layout:'multi-page'}});
 assert.equal(result.status,'review-required');
 assert.equal(result.files.length,6);
 const routes=['/','/about/','/services/','/contact/'];
 for(const [index,route] of routes.entries()){
  const page=result.files[index];
  assert.match(page.path,/^public\/(?:about\/|services\/|contact\/)?index\.html$/);
  assert(page.content.includes('rel="canonical" href="https://willow.example'+route+'"'));
  assert(page.content.includes('property="og:url" content="https://willow.example'+route+'"'));
  assert.equal((page.content.match(/rel="canonical"/g)||[]).length,1);
  assert.equal(page.afterSha256,digest(page.content));
 }
 const sitemap=result.files.at(-1).content;
 assert.equal((sitemap.match(/<loc>/g)||[]).length,4);
 for(const route of routes)assert(sitemap.includes('<loc>https://willow.example'+route+'</loc>'));
 assert(!result.files.some(f=>f.path.includes('.js')||f.path.endsWith('_redirects')));
});

test('ZIP/imported or unsupported source always requires manual review without modifying files',async()=>{
 for(const sourceKind of ['uploaded-zip','customer-zip','imported','existing-custom',undefined]){
  const result=await proposal({sourceKind});
  assert.equal(result.status,'manual-review-required');
  assert.deepEqual(result.files,[]);
  assert.equal(result.proposalSha256,null);
  assert.equal(result.canonicalOrigin,null);
 }
});

test('no verified current domain evidence means no URL/robots/sitemap proposal',async()=>{
 for(const evidence of [undefined,null,
  {...domainEvidence,kind:'self-asserted'},
  {...domainEvidence,githubUserId:77},
  {...domainEvidence,githubRepositoryId:1002},
  {...domainEvidence,cloudflareAccountId:'2'.repeat(32)},
  {...domainEvidence,pagesProjectId:'another-project'},
  {...domainEvidence,pagesProjectName:'other'},
  {...domainEvidence,sourceSha:'b'.repeat(40)},
  {...domainEvidence,checkedAt:now+500},
  {...domainEvidence,checkedAt:now-90000,expiresAt:now+10},
  {...domainEvidence,expiresAt:now-1}
 ]){
  const result=await proposal({domainEvidence:evidence});
  assert.equal(result.status,'blocked-domain-evidence');
  assert.deepEqual(result.files,[]);
  assert.equal(result.publicationVerified,false);
 }
});

test('canonical origin is HTTPS exact origin and not an attacker host/path',async()=>{
 const bad=['http://willow.example','https://willow.example/path',
  'https://willow.example/?q=1','https://willow.example/#x',
  'https://attacker.test','https://localhost','https://127.0.0.1',
  'https://willow.example:8443','https://user:pass@willow.example',
  'https://willow.example@attacker.invalid','javascript:alert(1)',
  'https://willow.example.evil.test', 'https://-bad.example',
  'https://bad-.example', 'https://a..example', 'https://[::1]/'];
 for(const origin of bad){
  const result=await proposal({domainEvidence:{...domainEvidence,origin}});
  assert.equal(result.status,'blocked-domain-evidence',origin);
  assert.deepEqual(result.files,[]);
 }
});

test('current owned-site identity and source SHA required before planning',async()=>{
 for(const broken of [
  {...trustedSite,githubUserId:0},
  {...trustedSite,githubRepositoryId:'1001'},
  {...trustedSite,cloudflareAccountId:'wrong'},
  {...trustedSite,pagesProjectId:''},
  {...trustedSite,pagesProjectName:'../wrong'},
  {...trustedSite,expectedBaseSha:'short'},
  {...trustedSite,branch:'dev'},
  undefined
 ]){
  const result=await proposal({trustedSite:broken});
  assert.equal(result.status,'blocked-site-identity');
  assert.deepEqual(result.files,[]);
 }
});

test('existing SEO files cannot be silently overwritten, duplicates also denied',async()=>{
 for(const existingPaths of [
  ['public/robots.txt'],['public/sitemap.xml'],
  ['public/index.html','public/robots.txt'],
  ['public/index.html','public/index.html']
 ]){
  const result=await proposal({existingPaths});
  assert.equal(result.status,'blocked-existing-seo-file');
  assert.deepEqual(result.files,[]);
 }
 assert.equal((await proposal({existingPaths:['public/index.html']})).status,'review-required');
 assert.equal((await proposal({existingPaths:[42]})).status,'blocked-file-inventory');
});

test('proposal digest binds origin, current base, mode and every output byte',async()=>{
 const first=await proposal();
 const otherDomain=await proposal({domainEvidence:{...domainEvidence,origin:'https://willow-two.example'}});
 const otherRevision='b'.repeat(40);
 const otherBase=await proposal({trustedSite:{...trustedSite,expectedBaseSha:otherRevision},
  domainEvidence:{...domainEvidence,sourceSha:otherRevision}});
 const otherPage=await proposal({site:{...site,about:'Verified new story'}});
 const multi=await proposal({sourceKind:'generated-multi-page'});
 for(const result of [otherDomain,otherBase,otherPage,multi]){
  assert.equal(result.status,'review-required');
  assert.notEqual(result.proposalSha256,first.proposalSha256);
 }
 assert.equal((await proposal()).proposalSha256,first.proposalSha256);
});

test('escaped user copy stays safe in all new head tags; no invented business facts',async()=>{
 const evil={...site,name:'<img src=x onerror=alert(1)>',
  about:'<script>alert("injection")</script> & testimonials'};
 const result=await proposal({site:evil});
 const html=result.files[0].content;
 assert(!html.includes('<img src=x'));
 assert(!html.includes('<script>'));
 assert(html.includes('&lt;img'));
 assert(html.includes('&lt;script'));
 assert(!html.includes('application/ld+json'));
 assert(!html.includes('streetAddress'));
 assert(!html.includes('aggregateRating'));
 assert(!html.includes('og:image'));
 assert(!html.includes('google-analytics'));
});

test('invalid renderer input fails instead of laundering unsafe website fields',async()=>{
 await assert.rejects(proposal({site:{...site,contactEmail:'javascript:alert(1)'}}));
 await assert.rejects(proposal({site:{...site,theme:'unsafe'}}));
 await assert.rejects(proposal({site:{...site,name:''}}));
});
