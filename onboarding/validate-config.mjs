#!/usr/bin/env node
// Nonsecret beta-onboarding config and isolated D1-schema preflight.
// Default is offline. --remote only runs a read-only query against the configured D1.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const DEFAULT_PATH=new URL("./wrangler.jsonc",import.meta.url);
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const REFERENCE_D1="00000000-0000-0000-0000-000000000000";
const TABLES=["onboarding_flows","onboarding_sessions","onboarding_launches"];
const INDEXES=["idx_onboarding_flows_expires","idx_onboarding_sessions_expires","idx_onboarding_launches_session"];
export function validateConfig(config){
  if(!config||typeof config!=="object"||Array.isArray(config))throw Error("Expected Wrangler config object");
  if(config.name!=="launch-and-own-onboarding-beta")throw Error("Unexpected onboarding Worker name");
  if(config.main!=="worker.mjs")throw Error("Unexpected onboarding entrypoint");
  if(typeof config.compatibility_date!=="string"||config.compatibility_date<"2026-08-04")throw Error("Onboarding requires modern Workers compatibility date");
  const db=config.d1_databases;
  if(!Array.isArray(db)||db.length!==1||db[0].binding!=="DB"||db[0].database_name!=="launch-and-own-onboarding-beta"||db[0].migrations_dir!=="migrations")
    throw Error("Expected exactly one dedicated onboarding D1 binding");
  const databaseId=db[0].database_id;
  if(typeof databaseId!=="string"||!UUID.test(databaseId)||databaseId===REFERENCE_D1)
    throw Error("Dedicated onboarding D1 UUID is missing or points at the reference form database");
  if(!config.observability?.enabled||!config.observability?.logs?.enabled||!config.observability?.traces?.enabled)
    throw Error("Onboarding logs and traces must be enabled");
  if(!Array.isArray(config.ratelimits)||config.ratelimits.length!==1||config.ratelimits[0].name!=="ONBOARDING_LIMITER")
    throw Error("Expected isolated onboarding rate-limit binding");
  if(Object.keys(config.vars||{}).some(k=>/SECRET|KEY|TOKEN|PASSWORD/i.test(k)))
    throw Error("Potential credentials must not be stored as plain vars");
  return {status:"configuration-valid",worker:config.name,databaseId,databaseName:db[0].database_name};
}
export async function checkRemoteSchema({accountId,token,databaseId,expectedDatabaseName="launch-and-own-onboarding-beta",fetchFn=fetch}){
  if(typeof accountId!=="string"||!/^[a-f0-9]{32}$/i.test(accountId))throw Error("CLOUDFLARE_ACCOUNT_ID must be 32 hex characters");
  if(typeof token!=="string"||!token)throw Error("CLOUDFLARE_API_TOKEN is required for --remote");
  if(typeof databaseId!=="string"||!UUID.test(databaseId)||databaseId===REFERENCE_D1)throw Error("Unsafe onboarding database ID");
  if(expectedDatabaseName!=="launch-and-own-onboarding-beta")throw Error("Unexpected onboarding database name");
  const url="https://api.cloudflare.com/client/v4/accounts/"+accountId+"/d1/database/"+databaseId;
  const headers={authorization:"Bearer "+token,accept:"application/json"};
  // Fail closed if an unrelated D1 database exists at the configured ID.
  const info=await fetchFn(url,{method:"GET",headers,redirect:"error"});
  if(!info.ok)throw Error("Cannot verify onboarding D1 identity (HTTP "+info.status+")");
  const metadata=await info.json();
  if(metadata.success!==true||metadata.result?.uuid!==databaseId||metadata.result?.name!==expectedDatabaseName)
    throw Error("Onboarding D1 identity mismatch; refusing to inspect an unrelated database");
  const r=await fetchFn(url+"/query",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({sql:"SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"}),redirect:"error"});
  if(!r.ok)throw Error("D1 read-only schema check denied (HTTP "+r.status+")");
  const body=await r.json();
  if(body.success!==true||!Array.isArray(body.result?.[0]?.results))throw Error("Cloudflare did not return schema information");
  const found=new Set(body.result[0].results.map(x=>x.name));
  const missing=[...TABLES,...INDEXES].filter(x=>!found.has(x));
  if(missing.length)throw Error("D1 schema incomplete: "+missing.join(", "));
  return {status:"schema-ready",databaseId,databaseName:expectedDatabaseName,tables:TABLES.length,indexes:INDEXES.length};
}
async function main(){
  const cfg=JSON.parse(readFileSync(DEFAULT_PATH,"utf8"));
  const report=validateConfig(cfg);
  if(process.argv.includes("--remote")){
    const ready=await checkRemoteSchema({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,databaseId:report.databaseId});
    console.log(JSON.stringify(ready));
  }else console.log(JSON.stringify(report));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  main().catch(e=>{console.error("Onboarding preflight failed:",e.message);process.exitCode=1});
}
