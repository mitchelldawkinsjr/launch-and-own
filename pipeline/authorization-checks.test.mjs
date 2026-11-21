import test from "node:test";
import assert from "node:assert/strict";
import {verifyProviderConnections} from "./authorization-checks.mjs";
const input={name:"Test Customer",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"tester",forms:false};
function mock({login="tester",cloudflareId=input.accountId,githubStatus=200,cloudflareStatus=200}={}) {
 const calls=[];
 const fetchFn=async(url,opts)=>{
   calls.push({url,authorization:opts.headers.authorization,method:opts.method});
   if(url==="https://api.github.com/user")return Response.json({login,id:12},{status:githubStatus});
   if(url==="https://api.cloudflare.com/client/v4/accounts/"+input.accountId)
     return Response.json({success:true,result:{id:cloudflareId,name:"Customer Account"}},{status:cloudflareStatus});
   throw Error("Unknown URL");
 };
 return {calls,fetchFn};
}
const opts=(fetchFn)=>({githubAccessToken:"ghu_test_value",cloudflareAccessToken:"cf_test_value",fetchFn});
test("verifies both live provider identities with separate bearer tokens",async()=>{
 const h=mock();const r=await verifyProviderConnections(input,opts(h.fetchFn));
 assert.equal(r.status,"identities-verified");
 assert.equal(r.provisioningStatus,"not-started");
 assert.equal(r.githubPagesIntegration,"not-verified");
 assert.equal(r.githubOwner,"tester");
 assert.equal(r.cloudflareAccountId,input.accountId);
 assert.equal(h.calls.length,2);
 assert.equal(h.calls[0].authorization,"Bearer ghu_test_value");
 assert.equal(h.calls[1].authorization,"Bearer cf_test_value");
 assert.equal(JSON.stringify(r).includes("test_value"),false);
});
test("rejects a connected GitHub user different from customer-selected owner",async()=>{
 const h=mock({login:"other"});
 await assert.rejects(verifyProviderConnections(input,opts(h.fetchFn)),/not the selected repository owner/);
 assert.equal(h.calls.length,1);
});
test("rejects Cloudflare token that returns another account",async()=>{
 const h=mock({cloudflareId:"ffffffffffffffffffffffffffffffff"});
 await assert.rejects(verifyProviderConnections(input,opts(h.fetchFn)),/account identity mismatch/);
});
test("rejects expired or forbidden GitHub authorization",async()=>{
 const h=mock({githubStatus:401});
 await assert.rejects(verifyProviderConnections(input,opts(h.fetchFn)),/GitHub authorization is unavailable/);
 assert.equal(h.calls.length,1);
});
test("missing token rejects before any provider request",async()=>{
 const h=mock();
 await assert.rejects(verifyProviderConnections(input,{githubAccessToken:"token",fetchFn:h.fetchFn}),/both required/);
 assert.equal(h.calls.length,0);
});
test("rejects forms and custom-domain requests before API calls",async()=>{
 const h=mock();
 await assert.rejects(verifyProviderConnections({...input,forms:true,ownerEmail:"owner@example.com"},opts(h.fetchFn)),/website-only/);
 await assert.rejects(verifyProviderConnections({...input,hostname:"example.com"},opts(h.fetchFn)),/website-only/);
 assert.equal(h.calls.length,0);
});
