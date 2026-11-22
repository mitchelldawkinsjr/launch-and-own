import test from "node:test";
import assert from "node:assert/strict";
import {revokeGitHubGrant,revokeCloudflareToken,revokeConnectedAccounts} from "./revoke-connections.mjs";
const input={githubToken:"ghu_secret",cloudflareToken:"cf_secret",ghClientId:"Iv1.id",ghClientSecret:"gh-secret",cfClientId:"cf-id",cfClientSecret:"cf-secret"};
test("GitHub grant revocation uses Basic auth and deletes OAuth grant (not just local cookie)",async()=>{
 let called=0;
 const ok=await revokeGitHubGrant({clientId:input.ghClientId,clientSecret:input.ghClientSecret,accessToken:input.githubToken,
 fetchFn:async(url,opts)=>{
  called++;assert.equal(url,"https://api.github.com/applications/Iv1.id/grant");
  assert.equal(opts.method,"DELETE");
  assert.equal(opts.headers.authorization,"Basic "+Buffer.from("Iv1.id:gh-secret").toString("base64"));
  assert.equal(JSON.parse(opts.body).access_token,"ghu_secret");
  assert.equal(opts.redirect,"manual");
  return new Response(null,{status:204});
 }});
 assert.equal(ok,true);assert.equal(called,1);
});
test("Cloudflare OAuth revoke uses form body with confidential client credentials",async()=>{
 const ok=await revokeCloudflareToken({clientId:input.cfClientId,clientSecret:input.cfClientSecret,accessToken:input.cloudflareToken,
 fetchFn:async(url,opts)=>{
  assert.equal(url,"https://dash.cloudflare.com/oauth2/revoke");
  assert.equal(opts.method,"POST");
  assert.equal(opts.headers.authorization,"Basic "+Buffer.from("cf-id:cf-secret").toString("base64"));
  assert.equal(new URLSearchParams(opts.body).get("token"),"cf_secret");
  assert.equal(new URLSearchParams(opts.body).get("token_type_hint"),"access_token");
  assert.equal(opts.redirect,"manual");
  return new Response(null,{status:200});
 }});
 assert.equal(ok,true);
});
test("both connected providers revoked without exposing tokens in return value",async()=>{
 const visited=[];
 const result=await revokeConnectedAccounts({...input,fetchFn:async(url)=>{
  visited.push(url);
  return new Response(null,{status:url.includes("github.com")?204:200});
 }});
 assert.deepEqual(result,{github:"revoked",cloudflare:"revoked",fullyRevoked:true});
 assert.equal(visited.length,2);
 assert(!JSON.stringify(result).includes("secret"));
});
test("Cloudflare revocation failing is reported but GitHub can still be revoked",async()=>{
 const result=await revokeConnectedAccounts({...input,fetchFn:async(url)=>{
  if(url.includes("cloudflare.com"))return new Response(null,{status:403});
  return new Response(null,{status:204});
 }});
 assert.equal(result.github,"revoked");assert.equal(result.cloudflare,"unconfirmed");assert.equal(result.fullyRevoked,false);
});
test("provider outage or thrown error does not leak token and does not block the other revocation",async()=>{
 const result=await revokeConnectedAccounts({...input,fetchFn:async(url)=>{
  if(url.includes("github.com"))throw Error("private provider diagnostic secret");
  return new Response(null,{status:200});
 }});
 assert.equal(result.github,"unconfirmed");assert.equal(result.cloudflare,"revoked");
 assert(!JSON.stringify(result).includes("private provider diagnostic"));
});
test("unconnected Cloudflare account is not sent a revoke request",async()=>{
 const calls=[];
 const result=await revokeConnectedAccounts({...input,cloudflareToken:null,fetchFn:async(url)=>{
  calls.push(url);return new Response(null,{status:204});
 }});
 assert.equal(result.cloudflare,"not-connected");assert.equal(result.github,"revoked");assert.equal(calls.length,1);
});
test("missing provider credentials do not leak details to callers",async()=>{
 const result=await revokeConnectedAccounts({...input,cfClientSecret:"",fetchFn:async()=>new Response(null,{status:204})});
 assert.equal(result.fullyRevoked,false);assert.equal(result.cloudflare,"unconfirmed");
});
