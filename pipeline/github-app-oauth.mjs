// GitHub App user-to-server OAuth using authorization code + PKCE.
// Use only in a trusted backend; user tokens and app client secrets are sensitive.
// Caller must bind state to an authenticated session and consume it once on callback.
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";

export const GITHUB_AUTH_URL="https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL="https://github.com/login/oauth/access_token";

const must=(value,key)=>{
  if(typeof value!=="string"||!value.trim())throw Error(key+" is required");
  return value;
};
const redirect=(value)=>{
  const url=new URL(must(value,"redirectUri"));
  if(url.protocol!=="https:"||url.username||url.password||url.hash)
    throw Error("Redirect must use HTTPS without credentials or fragment");
  return value;
};
const sameState=(left,right)=>{
  if(typeof left!=="string"||typeof right!=="string"||!(/^[A-Za-z0-9_-]{43}$/.test(left))||!(/^[A-Za-z0-9_-]{43}$/.test(right)))return false;
  const x=Buffer.from(left),y=Buffer.from(right);
  return x.length===y.length&&timingSafeEqual(x,y);
};
export function beginGitHubAppOAuth({clientId,redirectUri,offlineAccess=true},random=randomBytes){
  must(clientId,"clientId");
  redirect(redirectUri);
  if(typeof offlineAccess!=="boolean")throw Error("offlineAccess must be boolean");
  const state=random(32).toString("base64url");
  const codeVerifier=random(48).toString("base64url");
  if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{64}$/.test(codeVerifier))
    throw Error("OAuth random source must provide requested byte lengths");
  const url=new URL(GITHUB_AUTH_URL);
  url.searchParams.set("client_id",clientId);
  url.searchParams.set("redirect_uri",redirectUri);
  url.searchParams.set("state",state);
  url.searchParams.set("code_challenge",createHash("sha256").update(codeVerifier).digest("base64url"));
  url.searchParams.set("code_challenge_method","S256");
  if(offlineAccess)url.searchParams.set("scope","offline_access");
  // Keep the verifier and state in an encrypted, short-lived, authenticated backend session.
  return {authorizationUrl:url.toString(),session:{state,codeVerifier}};
}
export async function completeGitHubAppOAuth({
  clientId,clientSecret,redirectUri,code,receivedState,expectedState,codeVerifier,fetchFn=fetch
}){
  must(clientId,"clientId");
  must(clientSecret,"clientSecret");
  redirect(redirectUri);
  if(!sameState(receivedState,expectedState))throw Error("GitHub OAuth state mismatch");
  must(code,"authorization code");
  if(typeof codeVerifier!=="string"||!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier))
    throw Error("PKCE verifier missing or invalid");
  const body=new URLSearchParams({
    client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,
    code,code_verifier:codeVerifier
  });
  const r=await fetchFn(GITHUB_TOKEN_URL,{method:"POST",headers:{
    accept:"application/json","content-type":"application/x-www-form-urlencoded"
  },body:body.toString(),redirect:"error"});
  if(!r.ok)throw Error("GitHub App OAuth token exchange failed (HTTP "+r.status+")");
  const data=await r.json();
  if(data.error||typeof data.access_token!=="string"||!data.access_token||data.token_type?.toLowerCase()!=="bearer")
    throw Error("GitHub App OAuth token exchange rejected or malformed");
  // Never serialize this result into client-side HTML, chat, logs or a repository.
  return data;
}
