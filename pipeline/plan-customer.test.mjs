import test from "node:test";
import assert from "node:assert/strict";
import {planCustomer,slugify} from "./plan-customer.mjs";
const base={name:"Second Customer",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"example-owner"};
test("website-only plan is default and does not create forms",()=>{
 const p=planCustomer(base);assert.equal(p.mode,"plan-only");assert.equal(p.forms,false);assert.deepEqual(p.steps.map(s=>s.id),["github","pages","deploy"]);assert.equal(p.domain,"esp-second-customer-site.pages.dev");
});
test("forms opt-in includes D1, Turnstile, Worker, Access and human acceptance",()=>{
 const p=planCustomer({...base,forms:true,ownerEmail:"owner@example.com"});
 assert.deepEqual(p.steps.map(s=>s.id),["github","pages","deploy","d1","turnstile","worker","access","form-deploy","acceptance"]);
 assert.deepEqual(p.steps.find(s=>s.id==="worker").requires,["d1","turnstile"]);
});
test("plans are deterministic",()=>assert.deepEqual(planCustomer(base),planCustomer(base)));
test("rejects malformed input and missing consent prerequisites",()=>{
 for(const input of [null,{}, {...base,forms:true}, {...base,forms:"yes"}, {...base,accountId:"wrong"}, {...base,githubOwner:"bad/owner"}, {...base,hostname:"bad host"}, {...base,name:"!!!"}])assert.throws(()=>planCustomer(input));
});
test("safe names",()=>assert.equal(slugify("  My & New Site! "),"my-new-site"));
