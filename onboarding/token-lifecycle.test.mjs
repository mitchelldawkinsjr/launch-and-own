import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {seal,unseal} from "./crypto.mjs";
import {encryptGrant,getFreshAccessToken} from "./token-lifecycle.mjs";
const key="ab".repeat(32), id="cd".repeat(32), now=1784730000;
const envBase={TOKEN_ENCRYPTION_KEY:key,GH_CLIENT_ID:"Iv1.github",GH_CLIENT_SECRET:"gh_client_secret",
 CF_CLIENT_ID:"cf-client",CF_CLIENT_SECRET:"cf_client_secret"};
const grant=(provider)=>({access_token:provider+"-access",token_type:"bearer",expires_in:120,
 refresh_token:provider+"-refresh",refresh_token_expires_in:5000});
function harness(){
 const db=new DatabaseSync(":memory:");
 db.exec(readFileSync(new URL("./migrations/0001_initial.sql",import.meta.url),"utf8"));
 db.exec(readFileSync(new URL("./migrations/0002_token_rotation.sql",import.meta.url),"utf8"));
 const DB={prepare(sql){return {bind(...args){return {
   first:async()=>db.prepare(sql).get(...args)||null,
   run:async()=>db.prepare(sql).run(...args)
 }}}}};
 const env={...envBase,DB};
 const insert=(provider,fields)=>{
  const prefix=provider;
  const c=db.prepare("SELECT id_hash FROM onboarding_sessions WHERE id_hash=?").get(id);
  if(!c)db.prepare("INSERT INTO onboarding_sessions(id_hash,github_user_id,github_login,github_token_ct,csrf_ct,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
    .run(id,5,"tester","placeholder","csrf",now-10,now+3600);
  db.prepare("UPDATE onboarding_sessions SET "+prefix+"_token_ct=?, "+prefix+"_refresh_token_ct=?, "+prefix+"_token_expires_at=?, "+prefix+"_refresh_expires_at=? WHERE id_hash=?")
   .run(fields.accessCipher,fields.refreshCipher,fields.accessExpiresAt,fields.refreshExpiresAt,id);
 };
 const session=()=>({...db.prepare("SELECT * FROM onboarding_sessions WHERE id_hash=?").get(id),hash:id});
 return {env,db,insert,session};
}
test("encrypts both bearer and refresh token with unique AAD",async()=>{
 const value=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,grant:grant("github"),now});
 assert.equal(value.accessExpiresAt,now+120);
 assert.equal(value.refreshExpiresAt,now+5000);
 assert(!value.refreshCipher.includes("github-refresh"));
 assert(!value.accessCipher.includes("github-access"));
 assert.equal(await unseal(key,value.accessCipher,"github:"+id),"github-access");
 assert.equal(await unseal(key,value.refreshCipher,"github-refresh:"+id),"github-refresh");
 await assert.rejects(unseal(key,value.refreshCipher,"cloudflare-refresh:"+id));
});
test("unexpired tokens are used without refreshing",async()=>{
 const h=harness();const value=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,
  grant:{...grant("github"),expires_in:700},now});h.insert("github",value);
 let calls=0;
 const token=await getFreshAccessToken({env:h.env,provider:"github",session:h.session(),clock:()=>now,
  fetchFn:async()=>{calls++;throw Error("not called")}});
 assert.equal(token,"github-access");assert.equal(calls,0);
});
test("expired GitHub grant rotates tokens atomically and returns new bearer",async()=>{
 const h=harness(),v=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,grant:grant("github"),now:now-200});
 h.insert("github",v);
 let calls=0;
 const token=await getFreshAccessToken({env:h.env,session:h.session(),provider:"github",clock:()=>now,
  fetchFn:async(url,opts)=>{
   calls++;assert.equal(url,"https://github.com/login/oauth/access_token");
   const body=new URLSearchParams(opts.body);
   assert.equal(body.get("grant_type"),"refresh_token");assert.equal(body.get("refresh_token"),"github-refresh");
   assert.equal(body.get("client_secret"),"gh_client_secret");
   return Response.json({access_token:"new-github-access",token_type:"bearer",
     expires_in:28800,refresh_token:"new-ghr",refresh_token_expires_in:90000});
  }});
 assert.equal(token,"new-github-access");assert.equal(calls,1);
 const persisted=h.session();
 assert.equal(persisted.github_refresh_locked_until,null);
 assert.equal(await unseal(key,persisted.github_refresh_token_ct,"github-refresh:"+id),"new-ghr");
 assert.equal(persisted.github_token_expires_at,now+28800);
});
test("Cloudflare refresh uses confidential Basic authentication, independently of GitHub",async()=>{
 const h=harness(),v=await encryptGrant({provider:"cloudflare",sessionHash:id,encryptionKey:key,grant:grant("cf"),now:now-200});
 h.insert("cloudflare",v);
 const token=await getFreshAccessToken({env:h.env,session:h.session(),provider:"cloudflare",clock:()=>now,
 fetchFn:async(url,opts)=>{
  assert.equal(url,"https://dash.cloudflare.com/oauth2/token");
  assert.equal(opts.headers.authorization,"Basic "+Buffer.from("cf-client:cf_client_secret").toString("base64"));
  assert.equal(new URLSearchParams(opts.body).get("refresh_token"),"cf-refresh");
  return Response.json({access_token:"cf-new",token_type:"Bearer",expires_in:1800,refresh_token:"cf-new-refresh"});
 }});
 assert.equal(token,"cf-new");
 assert.equal(await unseal(key,h.session().cloudflare_refresh_token_ct,"cloudflare-refresh:"+id),"cf-new-refresh");
 assert.equal(h.session().cloudflare_refresh_locked_until,null);
});
test("concurrent renewal refuses a second use of a one-time refresh token",async()=>{
 const h=harness(),v=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,grant:grant("github"),now:now-200});
 h.insert("github",v);
 let started;const entered=new Promise(resolve=>started=resolve);
 let resume;const gate=new Promise(resolve=>resume=resolve);
 const fetchFn=async()=>{started();await gate;return Response.json({access_token:"rotated",token_type:"bearer",refresh_token:"new-refresh",expires_in:3600})};
 const first=getFreshAccessToken({env:h.env,session:h.session(),provider:"github",clock:()=>now,fetchFn});
 await entered;
 await assert.rejects(getFreshAccessToken({env:h.env,session:h.session(),provider:"github",clock:()=>now,fetchFn}),/already running/);
 resume();await first;
 assert.equal(h.session().github_refresh_locked_until,null);
});
test("failed refresh frees lease without storing unsafe token data",async()=>{
 const h=harness(),v=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,grant:grant("github"),now:now-200});
 h.insert("github",v);
 await assert.rejects(getFreshAccessToken({env:h.env,session:h.session(),provider:"github",clock:()=>now,
  fetchFn:async()=>new Response("credentials invalid",{status:401})}),/could not be renewed/);
 assert.equal(h.session().github_refresh_locked_until,null);
 assert.equal(h.session().github_token_ct,v.accessCipher);
});
test("no refresh token on an expired grant fails closed without network access",async()=>{
 const h=harness(),v=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,
  grant:{access_token:"expired",token_type:"bearer",expires_in:60},now:now-200});
 h.insert("github",v);
 await assert.rejects(getFreshAccessToken({env:h.env,session:h.session(),provider:"github",clock:()=>now,
 fetchFn:async()=>{throw Error("network should not be used")}}),/reconnect github/);
});
test("a refresh response missing a replacement refresh token does not discard the current encrypted one",async()=>{
 const h=harness(),v=await encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,grant:grant("github"),now:now-200});h.insert("github",v);
 await assert.rejects(getFreshAccessToken({env:h.env,session:h.session(),provider:"github",clock:()=>now,
  fetchFn:async()=>Response.json({access_token:"new-access",token_type:"bearer",expires_in:3600})}),/could not be renewed/);
 assert.equal(h.session().github_refresh_token_ct,v.refreshCipher);
 assert.equal(h.session().github_refresh_locked_until,null);
});
test("invalid OAuth grant lifetimes fail before encrypted storage",async()=>{
 for(const bad of [{expires_in:-1},{expires_in:"3600"},{refresh_token_expires_in:0}]){
  await assert.rejects(encryptGrant({provider:"github",sessionHash:id,encryptionKey:key,
   grant:{...grant("github"),...bad},now}),/Invalid OAuth/);
 }
});
