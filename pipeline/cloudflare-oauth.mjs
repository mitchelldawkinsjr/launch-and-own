// Cloudflare OAuth 2.0 Authorization Code + PKCE primitives for a trusted onboarding backend.
// No UI, account mutation, token persistence, or automatic consent is performed here.
// The caller MUST use an authenticated session, encrypted server-side state storage,
// one-time state consumption, and an exact registered redirect URI.
import {randomBytes, createHash, timingSafeEqual} from "node:crypto";

export const CLOUDFLARE_AUTH_URL="https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_TOKEN_URL="https://dash.cloudflare.com/oauth2/token";
const API="https://api.cloudflare.com/client/v4";

function nonempty(value,field) {
  if(typeof value!=="string"||!value.trim())throw Error(field+" is required");
  return value;
}
function secureRedirect(uri) {
  const value=nonempty(uri,"redirectUri");
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.hash)throw Error("Registered redirect URI must use HTTPS and have no credentials or fragment");
  return value;
}
function secureCompare(a,b) {
  if(typeof a!=="string"||typeof b!=="string"||!(/^[A-Za-z0-9_-]{43}$/.test(a))||!(/^[A-Za-z0-9_-]{43}$/.test(b)))return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length && timingSafeEqual(left,right);
}
function oauthScopes(scopes) {
  if(!Array.isArray(scopes)||!scopes.length||scopes.some(x=>typeof x!=="string"||!/^[a-z][a-z0-9._:-]+$/.test(x)))
    throw Error("At least one valid registered OAuth scope is required");
  if(new Set(scopes).size!==scopes.length)throw Error("Duplicate scopes are not allowed");
  return scopes.join(" ");
}
export function beginCloudflareOAuth({clientId,redirectUri,scopes},random=randomBytes) {
  nonempty(clientId,"clientId");
  secureRedirect(redirectUri);
  const scope=oauthScopes(scopes);
  const state=random(32).toString("base64url");
  const codeVerifier=random(48).toString("base64url");
  if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{64}$/.test(codeVerifier))
    throw Error("Cryptographically secure random bytes are required");
  const codeChallenge=createHash("sha256").update(codeVerifier).digest("base64url");
  const url=new URL(CLOUDFLARE_AUTH_URL);
  for(const [key,value] of Object.entries({
    response_type:"code",client_id:clientId,redirect_uri:redirectUri,
    scope,state,code_challenge:codeChallenge,code_challenge_method:"S256"
  }))url.searchParams.set(key,value);
  // DO NOT serialize codeVerifier or state into a public response, log, or repository.
  // Save them in a short-lived, server-side session bound to the actual end user.
  return {authorizationUrl:url.toString(),session:{state,codeVerifier}};
}
export async function completeCloudflareOAuth({
  clientId,redirectUri,code,receivedState,expectedState,codeVerifier,clientSecret,fetchFn=fetch
}) {
  nonempty(clientId,"clientId");
  secureRedirect(redirectUri);
  if(!secureCompare(receivedState,expectedState))throw Error("OAuth callback state mismatch");
  nonempty(code,"authorization code");
  if(typeof codeVerifier!=="string"||!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier))
    throw Error("Missing PKCE verifier");
  const body=new URLSearchParams({
    grant_type:"authorization_code",code,client_id:clientId,
    redirect_uri:redirectUri,code_verifier:codeVerifier
  });
  const headers={"content-type":"application/x-www-form-urlencoded","accept":"application/json"};
  if(clientSecret!==undefined){
    nonempty(clientSecret,"clientSecret");
    headers.authorization="Basic "+Buffer.from(clientId+":"+clientSecret).toString("base64");
  }
  const r=await fetchFn(CLOUDFLARE_TOKEN_URL,{method:"POST",headers,body:body.toString(),redirect:"error"});
  if(!r.ok)throw Error("Cloudflare OAuth token exchange failed (HTTP "+r.status+")");
  const data=await r.json();
  if(typeof data.access_token!=="string"||!data.access_token||data.token_type?.toLowerCase()!=="bearer")
    throw Error("Cloudflare OAuth token response was invalid");
  // SECRET: Only the backend receives this. Encrypt at rest if persisted.
  return data;
}
export async function verifyCloudflareAccount({accessToken,accountId,fetchFn=fetch}) {
  nonempty(accessToken,"accessToken");
  if(typeof accountId!=="string"||!/^[0-9a-f]{32}$/i.test(accountId))throw Error("Valid Cloudflare account ID is required");
  const url=API+"/accounts/"+encodeURIComponent(accountId);
  const r=await fetchFn(url,{method:"GET",headers:{authorization:"Bearer "+accessToken,accept:"application/json"},redirect:"error"});
  if(!r.ok)throw Error("Cannot access selected Cloudflare account (HTTP "+r.status+")");
  const data=await r.json();
  if(data.success!==true||data.result?.id!==accountId)throw Error("Cloudflare account identity mismatch");
  return {id:data.result.id,name:data.result.name||""};
}
