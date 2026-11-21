import test from "node:test";
import assert from "node:assert/strict";
import {launchWebsite} from "./launch-site.mjs";

const input={name:"Test Customer",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"tester"};
const HEAD_SHA="a".repeat(40);
const tokens={githubToken:"dummy-gh-token",cloudflareToken:"dummy-cf-token"};
test("operator launch checks the exact newly created revision, not any old Pages deployment",async()=>{
 let calls=0;
 const result=await launchWebsite(input,{...tokens,
  create:async(_input,opts)=>{
   calls++;
   assert.equal(opts.githubToken,tokens.githubToken);
   return {headCommitSha:HEAD_SHA,repository:"https://github.com/tester/esp-test-customer"};
  },
  verify:async(_input,opts,attempts,interval)=>{
   calls++;
   assert.equal(opts.cloudflareToken,tokens.cloudflareToken);
   assert.equal(opts.expectedCommitSha,HEAD_SHA);
   assert.equal(attempts,18);assert.equal(interval,15000);
   return {status:"live",website:"https://esp-test-customer-site.pages.dev",deploymentId:"deploy-id"};
  }
 });
 assert.equal(result.status,"live");assert.equal(result.githubCommitSha,HEAD_SHA);
 assert.equal(calls,2);
});
test("no commit SHA fails closed without making a Pages verification call",async()=>{
 let verified=0;
 await assert.rejects(launchWebsite(input,{...tokens,create:async()=>({repository:"https://github.com/tester/example"}),
  verify:async()=>{verified++}}),/no trustworthy GitHub commit/);
 assert.equal(verified,0);
});
test("malformed commit SHA fails closed",async()=>{
 await assert.rejects(launchWebsite(input,{...tokens,create:async()=>({headCommitSha:"short"}),
  verify:async()=>{throw Error("should not run")}}),/no trustworthy/);
});
test("queued old deployment cannot be reported as a successful launch",async()=>{
 await assert.rejects(launchWebsite(input,{...tokens,
  create:async()=>({headCommitSha:HEAD_SHA}),
  verify:async()=>({status:"pending-expected-commit"})
 }),/did not verify the expected GitHub production commit/);
});
test("missing credentials stop launch before provider mutations",async()=>{
 let created=0;
 await assert.rejects(launchWebsite(input,{githubToken:"token",create:async()=>{created++}}),/Authorized GitHub and Cloudflare tokens/);
 assert.equal(created,0);
});
test("custom polling options are forwarded to verification",async()=>{
 let called=false;
 await launchWebsite(input,{...tokens,attempts:2,intervalMs:1000,
  create:async()=>({headCommitSha:HEAD_SHA}),
  verify:async(_input,opts,n,interval)=>{
    called=true;assert.equal(n,2);assert.equal(interval,1000);
    assert.equal(opts.expectedCommitSha,HEAD_SHA);
    return {status:"live",website:"https://example.pages.dev"};
  }
 });
 assert.equal(called,true);
});
