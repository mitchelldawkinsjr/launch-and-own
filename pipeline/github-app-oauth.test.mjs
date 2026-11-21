import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {beginGitHubAppOAuth,completeGitHubAppOAuth,GITHUB_AUTH_URL,GITHUB_TOKEN_URL} from "./github-app-oauth.mjs";
const options={clientId:"Iv1.test-app-client",redirectUri:"https://onboarding.example.com/oauth/github/callback"};
const fakeRandom=n=>Buffer.alloc(n,0x25);
test("GitHub App authorization URL uses state and PKCE, not secrets",()=>{
 const {authorizationUrl,session}=beginGitHubAppOAuth(options,fakeRandom);
 const url=new URL(authorizationUrl);
 assert.equal(url.origin+url.pathname,GITHUB_AUTH_URL);
 assert.equal(url.searchParams.get("client_id"),options.clientId);
 assert.equal(url.searchParams.get("redirect_uri"),options.redirectUri);
 assert.equal(url.searchParams.get("scope"),"offline_access");
 assert.equal(url.searchParams.get("code_challenge_method"),"S256");
 assert.equal(url.searchParams.get("code_challenge"),createHash("sha256").update(session.codeVerifier).digest("base64url"));
 assert.equal(url.searchParams.get("state"),session.state);
 assert(!authorizationUrl.includes(session.codeVerifier));
});
test("optional offline access can be omitted without broad scopes",()=>{
 const r=beginGitHubAppOAuth({...options,offlineAccess:false},fakeRandom);
 assert.equal(new URL(r.authorizationUrl).searchParams.has("scope"),false);
});
test("rejects insecure redirect and malformed configuration",()=>{
 for(const input of [
  {...options,redirectUri:"http://onboarding.example.com/oauth/github/callback"},
  {...options,redirectUri:"https://name:pass@onboarding.example.com/callback"},
  {...options,redirectUri:"https://onboarding.example.com/callback#fragment"},
  {...options,clientId:""},
  {...options,offlineAccess:"true"}
 ])assert.throws(()=>beginGitHubAppOAuth(input),Error);
});
test("valid callback exchanges code and verifier using server secret",async()=>{
 const {session}=beginGitHubAppOAuth(options,fakeRandom);
 let calls=0;
 const result=await completeGitHubAppOAuth({...options,clientSecret:"server-secret",code:"code-value",
  receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async(url,opts)=>{
    calls++;
    assert.equal(url,GITHUB_TOKEN_URL);
    assert.equal(opts.method,"POST");
    assert.equal(opts.redirect,"error");
    assert.equal(opts.headers.accept,"application/json");
    const body=new URLSearchParams(opts.body);
    assert.equal(body.get("client_id"),options.clientId);
    assert.equal(body.get("client_secret"),"server-secret");
    assert.equal(body.get("code_verifier"),session.codeVerifier);
    assert.equal(body.get("redirect_uri"),options.redirectUri);
    assert.equal(body.get("code"),"code-value");
    return Response.json({access_token:"ghu_private_token",token_type:"bearer",expires_in:28800,refresh_token:"ghr_secret"});
  }});
 assert.equal(calls,1);
 assert.equal(result.access_token,"ghu_private_token");
 assert.equal(result.refresh_token,"ghr_secret");
});
test("callback rejects mismatched state before any network request",async()=>{
 const {session}=beginGitHubAppOAuth(options,fakeRandom);
 let called=0;
 await assert.rejects(completeGitHubAppOAuth({...options,clientSecret:"secret",code:"code",
  receivedState:"invalid",expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async()=>{called++;throw Error("must not call network")}
 }),/state mismatch/);
 assert.equal(called,0);
});
test("empty states never verify",async()=>{
 const {session}=beginGitHubAppOAuth(options,fakeRandom);
 await assert.rejects(completeGitHubAppOAuth({...options,clientSecret:"secret",code:"code",
  receivedState:"",expectedState:"",codeVerifier:session.codeVerifier,
  fetchFn:async()=>{throw Error("must not call network")}
 }),/state mismatch/);
});
test("never accepts github token exchange errors sent with HTTP 200",async()=>{
 const {session}=beginGitHubAppOAuth(options,fakeRandom);
 await assert.rejects(completeGitHubAppOAuth({...options,clientSecret:"secret",code:"code",
  receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async()=>Response.json({error:"bad_verification_code"})}),/rejected or malformed/);
});
test("never accepts malformed bearer response",async()=>{
 const {session}=beginGitHubAppOAuth(options,fakeRandom);
 await assert.rejects(completeGitHubAppOAuth({...options,clientSecret:"secret",code:"code",
  receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async()=>Response.json({access_token:"",token_type:"bearer"})}),/rejected or malformed/);
});
test("missing client secret cannot exchange an authorization code",async()=>{
 const {session}=beginGitHubAppOAuth(options,fakeRandom);
 let called=0;
 await assert.rejects(completeGitHubAppOAuth({...options,code:"code",
  receivedState:session.state,expectedState:session.state,codeVerifier:session.codeVerifier,
  fetchFn:async()=>{called++;throw Error("network should not run")}
 }),/clientSecret is required/);
 assert.equal(called,0);
});
