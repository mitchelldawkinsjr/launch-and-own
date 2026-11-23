import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateConfig,checkRemoteSchema} from "./validate-config.mjs";
import {LAUNCH_SCHEMA_PROBE} from "./launch-schema.mjs";
const cfg=JSON.parse(readFileSync(new URL("./wrangler.jsonc",import.meta.url),"utf8"));
const expectedId="b89fb8aa-67a2-49fa-b48c-584e305b5bb2";
const accountId="0123456789abcdef0123456789abcdef";
const expectedName="launch-and-own-onboarding-beta";
const copy=()=>structuredClone(cfg);
const schemaNames=["onboarding_flows","onboarding_sessions","onboarding_launches","onboarding_launch_receipts",
 "idx_onboarding_flows_expires","idx_onboarding_sessions_expires","idx_onboarding_launches_session",
 "idx_onboarding_receipts_owner","idx_onboarding_receipts_expiry","onboarding_launch_jobs","onboarding_launch_job_sessions",
 "idx_onboarding_jobs_due","idx_onboarding_jobs_owner","idx_onboarding_jobs_expiry",
 "idx_onboarding_job_sessions_session","idx_onboarding_launches_job","onboarding_jobs_delete_previews",
 "onboarding_option_approvals","idx_onboarding_option_approvals_owner","idx_onboarding_option_approvals_job",
 "onboarding_option_executions","idx_option_executions_owner","idx_option_executions_job_kind",
 "onboarding_forms_cost_privacy_approvals","idx_forms_cost_privacy_owner","idx_forms_cost_privacy_digest"];
const migrationNames=["0001_initial.sql","0002_token_rotation.sql","0003_launch_receipts.sql","0004_launch_jobs.sql",
 "0005_option_approvals.sql","0006_option_executions.sql","0007_option_kinds_analytics_previews.sql",
 "0008_forms_cost_privacy_approvals.sql"];
const tokenColumns=["github_refresh_token_ct","github_token_expires_at","github_refresh_expires_at","github_refresh_locked_until",
 "cloudflare_refresh_token_ct","cloudflare_token_expires_at","cloudflare_refresh_expires_at","cloudflare_refresh_locked_until"];
const mock=(overrides={})=>{
 const calls=[];
 const fetchFn=async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith("/query")){
    const sql=JSON.parse(options.body).sql;
    if(sql==="SELECT name FROM d1_migrations ORDER BY id"){
      if(overrides.ledgerUnavailable)return Response.json({success:false,result:[{success:false,errors:[{message:"missing ledger"}]}]});
      return Response.json({success:true,result:[{results:(overrides.migrations??migrationNames).map(name=>({name}))}]});
    }
    if(sql===LAUNCH_SCHEMA_PROBE){
      if(overrides.launchSchemaUnavailable)return Response.json({success:false,result:[{success:false}]});
      return Response.json({success:true,result:[{success:true,results:[]}]});
    }
    return Response.json({success:true,result:[{results:(sql.startsWith("PRAGMA")?(overrides.columns||tokenColumns):(overrides.schema||schemaNames)).map(name=>({name}))}]});
  }
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
 assert.equal(ready.status,"schema-ready");
 assert.equal(ready.tables,9);assert.equal(ready.indexes,16);assert.equal(ready.triggers,1);
 assert.equal(ready.tokenColumns,8);assert.equal(ready.migrations,8);
 assert.equal(h.calls.length,5);
 assert.equal(h.calls[0].options.method,"GET");
 assert.equal(JSON.parse(h.calls[4].options.body).sql,LAUNCH_SCHEMA_PROBE);
 assert.equal(JSON.parse(h.calls[3].options.body).sql,"SELECT name FROM d1_migrations ORDER BY id");
 assert.equal(JSON.parse(h.calls[2].options.body).sql,"PRAGMA table_info(onboarding_sessions)");
 assert.equal(h.calls[1].options.method,"POST");
 assert.equal(JSON.parse(h.calls[1].options.body).sql,"SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY name");
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
test("missing token-rotation migration columns block remote readiness",async()=>{
 const h=mock({columns:tokenColumns.slice(0,3)});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/token-rotation migration missing/);
 assert.equal(h.calls.length,3);
});
test("only the single onboard Custom Domain is allowed, with workers.dev disabled",()=>{
  const wild=copy();wild.routes=[{pattern:"*.360web.cloud/*",zone_name:"360web.cloud"}];
  assert.throws(()=>validateConfig(wild),/Custom Domain/);
  const apex=copy();apex.routes=[{pattern:"360web.cloud",custom_domain:true}];
  assert.throws(()=>validateConfig(apex),/Custom Domain/);
  const dev=copy();dev.workers_dev=true;
  assert.throws(()=>validateConfig(dev),/workers.dev/);
  const origin=copy();origin.vars.ONBOARDING_ORIGIN="https://www.360web.cloud";
  assert.throws(()=>validateConfig(origin),/ONBOARDING_ORIGIN/);
});
test("missing durable receipt migration stops onboarding readiness",async()=>{
 const h=mock({schema:schemaNames.filter(x=>!x.includes("receipts"))});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/schema incomplete/);
 assert.equal(h.calls.length,2);
});
test("missing job authorization table or preview cleanup trigger stops readiness",async()=>{
 for(const required of ["onboarding_launch_job_sessions","onboarding_jobs_delete_previews"]){
  const h=mock({schema:schemaNames.filter(name=>name!==required)});
  await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),
   {message:"D1 schema incomplete: "+required});
  assert.equal(h.calls.length,2);
 }
});

test("empty or out-of-sync Wrangler migration registry blocks remote readiness",async()=>{
 const [initial,rotation,receipts,jobs,options]=migrationNames;
 for(const migrations of [[],[initial],[initial,rotation,receipts],[initial,receipts,rotation,jobs],
  [initial,rotation,receipts,jobs],[...migrationNames,"0009_surprise.sql"]]){
  const h=mock({migrations});
  await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/migration ledger differs/);
  assert.equal(h.calls.length,4);
 }
 assert.equal(options,"0005_option_approvals.sql");
});
test("missing D1 migration ledger fails closed even if physical schema is correct",async()=>{
 const h=mock({ledgerUnavailable:true});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),/migration ledger is unavailable/);
 assert.equal(h.calls.length,4);
});
test("the correct migration ledger cannot mask missing durable job columns",async()=>{
 const h=mock({launchSchemaUnavailable:true});
 await assert.rejects(checkRemoteSchema({accountId,token:"t",databaseId:expectedId,fetchFn:h.fetchFn}),
  /durable launch schema is incomplete/);
 assert.equal(h.calls.length,5);
});
test("required hostname, origin and isolation flags cannot be removed from Wrangler",()=>{
 const invalid=[
  x=>{delete x.routes},
  x=>{x.routes=[]},
  x=>{x.routes.push({pattern:"evil.360web.cloud",custom_domain:true})},
  x=>{delete x.workers_dev},
  x=>{delete x.preview_urls},
  x=>{delete x.vars.ONBOARDING_ORIGIN}
 ];
 for(const mutate of invalid){
  const c=copy();mutate(c);
  assert.throws(()=>validateConfig(c),/Custom Domain|Disable workers.dev|ONBOARDING_ORIGIN/);
 }
});

test("ZIP preview Worker only gets its preview bindings, on the sibling-host route",()=>{
  const p=JSON.parse(readFileSync(new URL("./wrangler.preview.jsonc",import.meta.url),"utf8"));
  assert.equal(p.main,"zip-preview-worker.mjs");assert.equal(p.workers_dev,false);assert.equal(p.preview_urls,false);
  assert.deepEqual(p.routes,[{pattern:"*-zp.360web.cloud/*",zone_name:"360web.cloud"}]);
  assert.equal(p.d1_databases,undefined);assert.equal(p.ratelimits,undefined);assert.equal(p.triggers,undefined);
  assert.deepEqual(Object.keys(p.vars).sort(),["ONBOARDING_ORIGIN","ZIP_PREVIEW_DOMAIN"]);
  assert.equal(p.vars.ZIP_PREVIEW_DOMAIN,cfg.vars.ZIP_PREVIEW_DOMAIN);
  assert.equal(p.r2_buckets[0].bucket_name,cfg.r2_buckets[0].bucket_name);
});
