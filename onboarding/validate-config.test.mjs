import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateConfig,checkRemoteSchema} from "./validate-config.mjs";
const cfg=JSON.parse(readFileSync(new URL("./wrangler.jsonc",import.meta.url),"utf8"));
const expectedId="b89fb8aa-67a2-49fa-b48c-584e305b5bb2";
const accountId="0123456789abcdef0123456789abcdef";
const expectedName="launch-and-own-onboarding-beta";
const copy=()=>structuredClone(cfg);
const schemaNames=["onboarding_flows","onboarding_sessions","onboarding_launches",
 "idx_onboarding_flows_expires","idx_onboarding_sessions_expires","idx_onboarding_launches_session"];
const mock=(overrides={})=>{
 const calls=[];
 const fetchFn=async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith("/query"))return Response.json({success:true,result:[{results:(overrides.schema||schemaNames).map(name=>({name}))}]});
  return Response.json({success:true,result:{name:overrides.name||expectedName,uuid:overrides.uuid||expectedId}});
 };
 return {fetchFn,calls};
};
test("isolated beta database binding and safe observability configuration",()=>{
 const result=validateConfig(cfg);
 assert.equal(result.databaseId,expectedId);
 assert.equal(result.databaseName,expectedName);
 assert.equal(result.status,"configuration-valid");
});
test("placeholder, malformed ID, unrelated bindings and plain secret values are rejected",()=>{
 for(const id of ["REPLACE_WITH_INDEPENDENT_D1_UUID","00000000-0000-0000-0000-000000000000","bad-uuid"]){
  const value=copy();value.d1_databases[0].database_id=id;
  assert.throws(()=>validateConfig(value),/Dedicated onboarding D1 UUID/);
 }
 const extra=copy();extra.d1_databases.push({...extra.d1_databases[0],binding:"OTHER_DB"});
 assert.throws(()=>validateConfig(extra),/exactly one/);
 const secret=copy();secret.vars={TOKEN_ENCRYPTION_KEY:"plaintext"};
 assert.throws(()=>validateConfig(secret),/credentials/);
 const disabled=copy();disabled.observability.traces.enabled=false;
 assert.throws(()=>validateConfig(disabled),/logs and traces/);
});
test("remote readiness checks exact D1 metadata before read-only schema query",async()=>{
 const h=mock();
 const ready=await checkRemoteSchema({accountId,token:"test-secret",databaseId:expectedId,fetchFn:h.fetchFn});
 assert.equal(ready.status,"schema-ready");assert.equal(ready.indexes,3);
 assert.equal(h.calls.length,2);
 assert.equal(h.calls[0].options.method,"GET");
 assert.equal(h.calls[1].options.method,"POST");
 assert.equal(JSON.parse(h.calls[1].options.body).sql,"SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name");
 assert(!JSON.stringify(ready).includes("test-secret"));
});
test("cannot accidentally target an unrelated D1 by UUID",async()=>{
 const h=mock({uuid:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/identity mismatch/);
 assert.equal(h.calls.length,1);
});
test("cannot accidentally target an unrelated D1 by name",async()=>{
 const h=mock({name:"customer-contact-form"});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/identity mismatch/);
 assert.equal(h.calls.length,1);
});
test("missing tables or indexes fail readiness without claiming deployable state",async()=>{
 const h=mock({schema:["onboarding_flows","onboarding_sessions","onboarding_launches"]});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/schema incomplete/);
 assert.equal(h.calls.length,2);
});
test("missing provider authorization fails before network requests",async()=>{
 const h=mock();
 await assert.rejects(checkRemoteSchema({accountId,token:"",databaseId:expectedId,fetchFn:h.fetchFn}),/API_TOKEN/);
 assert.equal(h.calls.length,0);
});
test("Cloudflare authorization failure is surfaced as a readiness blocker",async()=>{
 const h=mock();const fetchFn=async()=>new Response("denied",{status:403});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn}),/Cannot verify/);
});
test("only the single onboard Custom Domain is allowed, with workers.dev disabled",()=>{
  const wild=copy();wild.routes=[{pattern:"*.mitchelldawkins.com/*",zone_name:"mitchelldawkins.com"}];
  assert.throws(()=>validateConfig(wild),/Custom Domain/);
  const apex=copy();apex.routes=[{pattern:"mitchelldawkins.com",custom_domain:true}];
  assert.throws(()=>validateConfig(apex),/Custom Domain/);
  const dev=copy();dev.workers_dev=true;
  assert.throws(()=>validateConfig(dev),/workers.dev/);
  const origin=copy();origin.vars.ONBOARDING_ORIGIN="https://www.mitchelldawkins.com";
  assert.throws(()=>validateConfig(origin),/ONBOARDING_ORIGIN/);
});
