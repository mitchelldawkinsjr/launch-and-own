import test from "node:test";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {verifyWebsite,waitForWebsite} from "./verify-site.mjs";
const input={name:"Test Client",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"tester"};
const projectName="esp-test-client-site",site="https://"+projectName+".pages.dev";
const EXPECTED_SHA="a".repeat(40),NEXT_SHA="b".repeat(40);
const DEFAULT_HTML="<html><body>Test Client</body></html>";
const htmlHash=html=>createHash("sha256").update(html,"utf8").digest("hex");
function mock({canonical=true,environment="production",latestQueued=false,htmlStatus=200,
  htmlType="text/html",html=DEFAULT_HTML,otherSource=false}={}) {
 const calls=[];
 const project={name:projectName,source:{type:"github",config:{owner:"tester",repo_name:otherSource?"another-repo":"esp-test-client"}},
  canonical_deployment:canonical?{id:"deploy-success",environment,latest_stage:{name:"deploy",status:"success"},
    deployment_trigger:{metadata:{commit_hash:EXPECTED_SHA}}}:null,
  latest_deployment:latestQueued?{id:"newer",latest_stage:{name:"queued",status:"idle"}}:{id:"deploy-success",latest_stage:{name:"deploy",status:"success"}}};
 const fetchFn=async(url,opts={})=>{
  calls.push(url);
  if(url.includes("api.cloudflare.com"))return Response.json({success:true,result:project});
  if(url===site+"/")return new Response(html,{status:htmlStatus,headers:{"content-type":htmlType}});
  throw Error("Unexpected URL: "+url);
 };
 return {calls,fetchFn};
}
test("successful production deployment and accessible HTML are verified live",async()=>{
 const h=mock();const result=await verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn});
 assert.equal(result.status,"live");
 assert.equal(result.website,site);
 assert.equal(result.latestPending,false);
 assert.equal(result.publicHtmlSha256,htmlHash(DEFAULT_HTML));
 assert.equal(h.calls.length,2);
});
test("queued deployment is not falsely reported live",async()=>{
 const h=mock({canonical:false,latestQueued:true});
 const r=await verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn});
 assert.equal(r.status,"pending-deployment");assert.equal(h.calls.length,1);
});
test("last successful production remains live while later deployment is queued",async()=>{
 const h=mock({canonical:true,latestQueued:true});
 const r=await verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn});
 assert.equal(r.status,"live");assert.equal(r.latestPending,true);
});
test("wrong GitHub source fails closed",async()=>{
 const h=mock({otherSource:true});
 await assert.rejects(verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn}),/source mismatch/);
 assert.equal(h.calls.length,1);
});
test("public site not yet reachable does not claim deployment success",async()=>{
 const h=mock({htmlStatus:404});
 const r=await verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn});
 assert.equal(r.status,"pending-public-reachability");assert.equal(r.httpStatus,404);
});
test("unexpected public content is treated as a verification failure",async()=>{
 const h=mock({htmlType:"application/json"});
 assert.equal((await verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn})).status,"unexpected-public-content");
});
test("html content must contain html markup",async()=>{
 const h=mock({html:"not an html document"});
 assert.equal((await verifyWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn})).status,"unexpected-public-content");
});
test("reject unsupported configuration before making API requests",async()=>{
 const h=mock();
 await assert.rejects(verifyWebsite({...input,forms:true,ownerEmail:"owner@example.com"},{cloudflareToken:"token",fetchFn:h.fetchFn}),/website-only/);
 assert.equal(h.calls.length,0);
});
test("no credential means no API calls",async()=>{
 const h=mock();
 await assert.rejects(verifyWebsite(input,{fetchFn:h.fetchFn}),/CLOUDFLARE_API_TOKEN/);
 assert.equal(h.calls.length,0);
});
test("bounded poll rejects after one unsuccessful check",async()=>{
 const h=mock({canonical:false});
 await assert.rejects(waitForWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn},1,1000),/not verified/);
 assert.equal(h.calls.length,1);
});
test("invalid poll limits fail immediately",async()=>{
 const h=mock();
 await assert.rejects(waitForWebsite(input,{cloudflareToken:"token",fetchFn:h.fetchFn},0,1000),/attempts must/);
 assert.equal(h.calls.length,0);
});

test("exact newly approved commit is required before reporting a new customer website live",async()=>{
 const h=mock();
 const result=await verifyWebsite(input,{cloudflareToken:"token",expectedCommitSha:EXPECTED_SHA,fetchFn:h.fetchFn});
 assert.equal(result.status,"live");
 assert.equal(h.calls.length,2);
});
test("older successful production deploy cannot satisfy a newer approved revision",async()=>{
 const h=mock({latestQueued:true});
 const result=await verifyWebsite(input,{cloudflareToken:"token",expectedCommitSha:NEXT_SHA,fetchFn:h.fetchFn});
 assert.equal(result.status,"pending-expected-commit");
 assert.equal(result.expectedCommit,NEXT_SHA);
 assert.equal(result.deployedCommit,EXPECTED_SHA);
 assert.equal(h.calls.length,1,"Do not check stale homepage while awaiting expected commit");
});
test("invalid expected commit fails before any Cloudflare or public requests",async()=>{
 const h=mock();
 await assert.rejects(verifyWebsite(input,{cloudflareToken:"token",expectedCommitSha:"not-a-sha",fetchFn:h.fetchFn}),/full 40-character/);
 assert.equal(h.calls.length,0);
});
test("strict polling rejects when older commit remains live",async()=>{
 const h=mock({latestQueued:true});
 await assert.rejects(waitForWebsite(input,{cloudflareToken:"token",expectedCommitSha:NEXT_SHA,fetchFn:h.fetchFn},1,1000),/not verified/);
 assert.equal(h.calls.length,1);
});

test("exact approved HTML digest must match public page bytes before live is claimed",async()=>{
 const h=mock();
 const result=await verifyWebsite(input,{
  cloudflareToken:"token",expectedCommitSha:EXPECTED_SHA,
  expectedHtmlSha256:htmlHash(DEFAULT_HTML).toUpperCase(),fetchFn:h.fetchFn
 });
 assert.equal(result.status,"live");
 assert.equal(result.publicHtmlSha256,htmlHash(DEFAULT_HTML));
 assert.equal(h.calls.length,2);
});
test("correct canonical commit with stale public HTML fails closed",async()=>{
 const h=mock({html:"<html><body>Old approved copy</body></html>"});
 const result=await verifyWebsite(input,{
  cloudflareToken:"token",expectedCommitSha:EXPECTED_SHA,
  expectedHtmlSha256:htmlHash(DEFAULT_HTML),fetchFn:h.fetchFn
 });
 assert.equal(result.status,"pending-expected-html");
 assert.equal(result.expectedHtmlSha256,htmlHash(DEFAULT_HTML));
 assert.equal(result.publicHtmlSha256,htmlHash("<html><body>Old approved copy</body></html>"));
 assert.equal(h.calls.length,2);
});
test("an extra UTF-8 byte order mark changes the exact public digest",async()=>{
 const html="\uFEFF"+DEFAULT_HTML;
 const h=mock({html});
 const result=await verifyWebsite(input,{
  cloudflareToken:"token",expectedCommitSha:EXPECTED_SHA,
  expectedHtmlSha256:htmlHash(DEFAULT_HTML),fetchFn:h.fetchFn
 });
 assert.equal(result.status,"pending-expected-html");
 assert.equal(result.publicHtmlSha256,htmlHash(html));
});
test("the expected commit and HTML cannot make a preview deployment count as production",async()=>{
 const h=mock({environment:"preview"});
 const result=await verifyWebsite(input,{
  cloudflareToken:"token",expectedCommitSha:EXPECTED_SHA,
  expectedHtmlSha256:htmlHash(DEFAULT_HTML),fetchFn:h.fetchFn
 });
 assert.equal(result.status,"pending-deployment");
 assert.equal(h.calls.length,1);
});
test("invalid approved HTML digest cannot trigger provider requests",async()=>{
 const h=mock();
 await assert.rejects(verifyWebsite(input,{
  cloudflareToken:"token",expectedHtmlSha256:"invalid",fetchFn:h.fetchFn
 }),/64-character digest/);
 assert.equal(h.calls.length,0);
});
test("old public content cannot satisfy bounded launch verification",async()=>{
 const h=mock({html:"<html><body>Unexpected</body></html>"});
 await assert.rejects(waitForWebsite(input,{
  cloudflareToken:"token",expectedHtmlSha256:htmlHash(DEFAULT_HTML),fetchFn:h.fetchFn
 },1,1000),/pending-expected-html/);
 assert.equal(h.calls.length,2);
});

// An approved project created after its commit has nothing to build until something starts it.
function approvedProjectMock({latest=null,startStatus=200,repositoryId=42,headSha=EXPECTED_SHA}={}){
 const posts=[];
 const requests=[];
 const project={id:"proj-1",name:projectName,subdomain:projectName+".pages.dev",production_branch:"main",
  source:{type:"github",config:{owner:"tester",repo_name:"esp-test-client",repo_id:42,production_deployments_enabled:true}},
  build_config:{build_command:"",destination_dir:"public",root_dir:"/"},canonical_deployment:null,latest_deployment:latest};
 const fetchFn=async(url,opts={})=>{
  requests.push(url);
  if(url.endsWith("/deployments")&&opts.method==="POST"){posts.push(opts.body.get("branch"));return Response.json({success:true},{status:startStatus});}
  if(url.includes("api.cloudflare.com"))return Response.json({success:true,result:project});
  assert.equal(opts.headers.authorization,"Bearer github-grant");
  if(url.endsWith("/repos/tester/esp-test-client"))return Response.json({id:repositoryId,name:"esp-test-client",
    owner:{id:12,login:"tester"},private:true,default_branch:"main"});
  if(url.endsWith("/repos/tester/esp-test-client/branches/main"))return Response.json({commit:{sha:headSha}});
  throw Error("Unexpected URL: "+url);
 };
 return {posts,requests,fetchFn};
}
const approvedTarget={repositoryId:42,githubUserId:12,branch:"main",projectId:"proj-1",html:DEFAULT_HTML};
const firstBuildOptions={cloudflareToken:"token",githubToken:"github-grant",expectedCommitSha:EXPECTED_SHA,approved:approvedTarget};
test("approved project that never deployed gets exactly one production build started",async()=>{
 const h=approvedProjectMock();
 const r=await verifyWebsite(input,{...firstBuildOptions,fetchFn:h.fetchFn});
 assert.equal(r.status,"pending-deployment");assert.deepEqual(h.posts,["main"]);
 assert.match(h.requests.at(-2),/github\.com\/repos\/tester\/esp-test-client\/branches\/main$/);
});
test("first build requires the same private GitHub repository and approved branch revision",async()=>{
 for(const [options,message] of [
  [{repositoryId:43},/repository differs/],
  [{headSha:"f".repeat(40)},/branch moved/]
 ]){
  const h=approvedProjectMock(options);
  await assert.rejects(verifyWebsite(input,{...firstBuildOptions,fetchFn:h.fetchFn}),message);
  assert.deepEqual(h.posts,[]);
 }
});
test("a queued or running build is never started twice",async()=>{
 const h=approvedProjectMock({latest:{id:"d1",latest_stage:{name:"build",status:"active"}}});
 const r=await verifyWebsite(input,{cloudflareToken:"token",expectedCommitSha:EXPECTED_SHA,approved:approvedTarget,fetchFn:h.fetchFn});
 assert.equal(r.status,"pending-deployment");assert.deepEqual(h.posts,[]);
 assert.equal(h.requests.length,1);
});
test("a refused first build surfaces the provider status instead of waiting forever",async()=>{
 const h=approvedProjectMock({startStatus:403});
 await assert.rejects(verifyWebsite(input,{...firstBuildOptions,fetchFn:h.fetchFn}),err=>err.status===403||/403/.test(String(err.message)));
});
