import test from "node:test";
import assert from "node:assert/strict";
import {verifyWebsite,waitForWebsite} from "./verify-site.mjs";
const input={name:"Test Client",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"tester"};
const projectName="esp-test-client-site",site="https://"+projectName+".pages.dev";
const EXPECTED_SHA="a".repeat(40),NEXT_SHA="b".repeat(40);
function mock({canonical=true,latestQueued=false,htmlStatus=200,htmlType="text/html",html="<html><body>Test Client</body></html>",otherSource=false}={}) {
 const calls=[];
 const project={name:projectName,source:{type:"github",config:{owner:"tester",repo_name:otherSource?"another-repo":"esp-test-client"}},
  canonical_deployment:canonical?{id:"deploy-success",latest_stage:{name:"deploy",status:"success"},deployment_trigger:{metadata:{commit_hash:EXPECTED_SHA}}}:null,
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
