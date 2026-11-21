import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {beginCloudflareOAuth,completeCloudflareOAuth,verifyCloudflareAccount,CLOUDFLARE_AUTH_URL,CLOUDFLARE_TOKEN_URL} from "./cloudflare-oauth.mjs";
const client={clientId:"client-public-id",redirectUri:"https://onboarding.example.com/oauth/cloudflare/callback",scopes:["workers-platform.read","workers-platform.write"]};
const random=(length)=>Buffer.alloc(length,0x13);
test("OAuth URL contains correct Cloudflare endpoint, state and S256 challenge but never verifier",()=>{
 const {authorizationUrl,session}=beginCloudflareOAuth(client,random);
 const url=new URL(authorizationUrl);
 assert.equal(url.origin+url.pathname,CLOUDFLARE_AUTH_URL);
 assert.equal(url.searchParams.get("client_id"),client.clientId);
 assert.equal(url.searchParams.get("redirect_uri"),client.redirectUri);
 assert.equal(url.searchParams.get("response_type"),"code");
 assert.equal(url.searchParams.get("code_challenge_method"),"S256");
 assert.equal(url.searchParams.get("scope"),client.scopes.join(" "));
 assert.equal(url.searchParams.get("code_challenge"),createHash("sha256").update(session.codeVerifier).digest("base64url"));
 assert.equal(url.searchParams.get("state"),session.state);
 assert(!authorizationUrl.includes(session.codeVerifier));
 assert.equal(session.codeVerifier.length,64);
});
test("malformed consent configuration is rejected",()=>{
 for(const invalid of [
   {...client,clientId:""},
   {...client,redirectUri:"http://example.com/callback"},
   {...client,redirectUri:"https://u:p@example.com/callback"},
   {...client,redirectUri:"https://example.com/callback#fragment"},
   {...client,scopes:[]},
   {...client,scopes:["pages.write","pages.write"]},
   {...client,scopes:["pages.read invalid"]}
 ])assert.throws(()=>beginCloudflareOAuth(invalid),Error);
});
test("token exchange sends verifier in form body but not URL or bearer header",async()=>{
 const {session}=beginCloudflareOAuth(client,random);
 let called=0;
 const fetchFn=async(url,opts)=>{
   called++;
   assert.equal(url,CLOUDFLARE_TOKEN_URL);
   assert.equal(opts.method,"POST");
   assert.equal(opts.headers.authorization,undefined);
   assert.equal(opts.redirect,"error");
   const b=new URLSearchParams(opts.body);
   assert.equal(b.get("code_verifier"),session.codeVerifier);
   assert.equal(b.get("client_id"),client.clientId);
   assert.equal(b.get("code"),"code-xyz");
   return Response.json({access_token:"private-access-token",token_type:"Bearer",expires_in:3600});
 };
 const result=await completeCloudflareOAuth({
   clientId:client.clientId,redirectUri:client.redirectUri,
   code:"code-xyz",receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,fetchFn
 });
 assert.equal(called,1);
 assert.equal(result.access_token,"private-access-token");
});
test("confidential backend token exchange uses basic auth",async()=>{
 const {session}=beginCloudflareOAuth(client,random);
 await completeCloudflareOAuth({
  clientId:client.clientId,redirectUri:client.redirectUri,clientSecret:"server-secret",
  code:"valid-code",receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async(_url,opts)=>{
    assert.equal(opts.headers.authorization,"Basic "+Buffer.from(client.clientId+":server-secret").toString("base64"));
    return Response.json({access_token:"private",token_type:"Bearer"});
  }
 });
});
test("state mismatch stops callback before any token request",async()=>{
 const {session}=beginCloudflareOAuth(client,random);
 let calls=0;
 await assert.rejects(completeCloudflareOAuth({
  clientId:client.clientId,redirectUri:client.redirectUri,code:"code",
  receivedState:"wrong-state",expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async()=>{calls++;throw Error("should not call")}
 }),/state mismatch/);
 assert.equal(calls,0);
});
test("missing state is never accepted, including both missing values",async()=>{
 const {session}=beginCloudflareOAuth(client,random);
 await assert.rejects(completeCloudflareOAuth({clientId:client.clientId,redirectUri:client.redirectUri,code:"code",codeVerifier:session.codeVerifier,receivedState:"",expectedState:"",fetchFn:async()=>{throw Error("not called")}}),/state mismatch/);
});
test("invalid token payload fails closed",async()=>{
 const {session}=beginCloudflareOAuth(client,random);
 await assert.rejects(completeCloudflareOAuth({
  clientId:client.clientId,redirectUri:client.redirectUri,code:"code",
  receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async()=>Response.json({access_token:"",token_type:"Bearer"})
 }),/invalid/);
});
test("selected Cloudflare account is verified against the token and returned identity",async()=>{
 const id="0123456789abcdef0123456789abcdef";
 let calls=0;
 const result=await verifyCloudflareAccount({accessToken:"private-token",accountId:id,fetchFn:async(url,opts)=>{
  calls++;
  assert.equal(url,"https://api.cloudflare.com/client/v4/accounts/"+id);
  assert.equal(opts.headers.authorization,"Bearer private-token");
  return Response.json({success:true,result:{id,name:"My Account"}});
 }});
 assert.equal(calls,1);
 assert.deepEqual(result,{id,name:"My Account"});
});
test("cannot impersonate another Cloudflare account",async()=>{
 const id="0123456789abcdef0123456789abcdef";
 await assert.rejects(verifyCloudflareAccount({accessToken:"private-token",accountId:id,
   fetchFn:async()=>Response.json({success:true,result:{id:"ffffffffffffffffffffffffffffffff"}})}),/identity mismatch/);
});
test("denied account permission is a failure",async()=>{
 const id="0123456789abcdef0123456789abcdef";
 await assert.rejects(verifyCloudflareAccount({accessToken:"private-token",accountId:id,
   fetchFn:async()=>new Response(JSON.stringify({success:false}),{status:403})}),/Cannot access/);
});
