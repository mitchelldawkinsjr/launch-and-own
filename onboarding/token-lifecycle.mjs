// Provider-neutral, encrypted OAuth grant lifecycle with one-at-a-time D1 rotation.
// No token, secret or provider response body may be logged or returned to a browser.
import {seal,unseal} from "./crypto.mjs";

const PROVIDERS=Object.freeze({
  github:{prefix:"github",endpoint:"https://github.com/login/oauth/access_token"},
  cloudflare:{prefix:"cloudflare",endpoint:"https://dash.cloudflare.com/oauth2/token"}
});
const MIN_REFRESH_WINDOW=90; // seconds before access-token expiry
const REFRESH_LEASE=30; // seconds; outbound refresh has a shorter deadline
export class AuthorizationRefreshBusy extends Error {}
const safeInt=(x)=>Number.isSafeInteger(x)&&x>0&&x<=366*24*3600;
const right=(name)=>{
  if(!Object.hasOwn(PROVIDERS,name))throw Error("Unknown OAuth provider");
  return PROVIDERS[name];
};
function grantLifetime(grant,now){
  if(!grant||typeof grant.access_token!=="string"||!grant.access_token||
    typeof grant.token_type!=="string"||grant.token_type.toLowerCase()!=="bearer")
    throw Error("OAuth provider returned no usable bearer token");
  if(grant.expires_in!==undefined&&!safeInt(grant.expires_in))throw Error("Invalid OAuth access expiration");
  if(grant.refresh_token!==undefined&&(typeof grant.refresh_token!=="string"||!grant.refresh_token))
    throw Error("Invalid OAuth refresh credential");
  const refreshTtl=grant.refresh_token_expires_in??grant.refresh_expires_in;
  if(refreshTtl!==undefined&&!safeInt(refreshTtl))throw Error("Invalid OAuth refresh expiration");
  const expires=grant.expires_in===undefined?null:now+grant.expires_in;
  const refreshExpires=refreshTtl===undefined?null:now+refreshTtl;
  return {expires,refreshExpires};
}
export async function encryptGrant({grant,provider,sessionHash,encryptionKey,now=Math.floor(Date.now()/1000)}){
  const prefix=right(provider).prefix;
  if(typeof sessionHash!=="string"||!/^[a-f0-9]{64}$/i.test(sessionHash))throw Error("Invalid session identifier");
  const times=grantLifetime(grant,now);
  return {
    accessCipher:await seal(encryptionKey,grant.access_token,prefix+":"+sessionHash),
    refreshCipher:grant.refresh_token?await seal(encryptionKey,grant.refresh_token,prefix+"-refresh:"+sessionHash):null,
    accessExpiresAt:times.expires,
    refreshExpiresAt:times.refreshExpires
  };
}
async function refreshWithProvider({provider,refreshToken,clientId,clientSecret,fetchFn}){
  const info=right(provider);
  if(!refreshToken||!clientId||!clientSecret)throw Error("Account needs to reconnect");
  const payload=new URLSearchParams({
    grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId
  });
  const headers={accept:"application/json","content-type":"application/x-www-form-urlencoded"};
  if(provider==="github")payload.set("client_secret",clientSecret);
  else headers.authorization="Basic "+Buffer.from(clientId+":"+clientSecret).toString("base64");
  const res=await fetchFn(info.endpoint,{
    method:"POST",redirect:"manual",headers,body:payload.toString(),
    signal:AbortSignal.timeout(12000)
  });
  if(!res.ok)throw Error("Account authorization renewal failed; reconnect the provider");
  const grant=await res.json();
  if(grant?.error||typeof grant?.refresh_token!=="string"||!grant.refresh_token||!safeInt(grant.expires_in))
    throw Error("Provider did not return a new expiring grant; reconnect the provider");
  grantLifetime(grant,Math.floor(Date.now()/1000));
  return grant;
}
export async function getFreshAccessToken({
  env,session,provider,fetchFn=fetch,clock=()=>Math.floor(Date.now()/1000)
}){
  const info=right(provider),prefix=info.prefix;
  if(!session||typeof session.hash!=="string")throw Error("Account needs to reconnect");
  const encrypted=session[prefix+"_token_ct"];
  if(!encrypted)throw Error("Connect "+provider+" to continue");
  const expires=session[prefix+"_token_expires_at"];
  // Null means a legacy or non-expiring grant. Never assume an explicitly
  // expiring token is usable once within the refresh window.
  if(expires==null||expires>clock()+MIN_REFRESH_WINDOW)
    return await unseal(env.TOKEN_ENCRYPTION_KEY,encrypted,prefix+":"+session.hash);
  const refreshCt=session[prefix+"_refresh_token_ct"];
  const refreshExpires=session[prefix+"_refresh_expires_at"];
  if(!refreshCt||(refreshExpires!=null&&refreshExpires<=clock()+MIN_REFRESH_WINDOW))
    throw Error("Account authorization expired; reconnect "+provider);
  const until=clock()+REFRESH_LEASE;
  // Conditional D1 write prevents concurrent one-time refresh-token use.
  const lockCol=prefix+"_refresh_locked_until",refreshCol=prefix+"_refresh_token_ct";
  const acquired=await env.DB.prepare(
    "UPDATE onboarding_sessions SET "+lockCol+"=? WHERE id_hash=? AND expires_at>? AND "+refreshCol+"=? AND ("+lockCol+" IS NULL OR "+lockCol+"<=?) RETURNING id_hash"
  ).bind(until,session.hash,clock(),refreshCt,clock()).first();
  if(!acquired)throw new AuthorizationRefreshBusy("Authorization renewal is already running; retry the request");
  const clientId=provider==="github"?env.GH_CLIENT_ID:env.CF_CLIENT_ID;
  const clientSecret=provider==="github"?env.GH_CLIENT_SECRET:env.CF_CLIENT_SECRET;
  try{
    const refreshToken=await unseal(env.TOKEN_ENCRYPTION_KEY,refreshCt,prefix+"-refresh:"+session.hash);
    const grant=await refreshWithProvider({provider,refreshToken,clientId,clientSecret,fetchFn});
    const rotated=await encryptGrant({
      provider,sessionHash:session.hash,encryptionKey:env.TOKEN_ENCRYPTION_KEY,grant,now:clock()
    });
    const updated=await env.DB.prepare(
      "UPDATE onboarding_sessions SET "+prefix+"_token_ct=?, "+refreshCol+"=?, "+prefix+
      "_token_expires_at=?, "+prefix+"_refresh_expires_at=?, "+lockCol+
      "=NULL WHERE id_hash=? AND "+refreshCol+"=? AND "+lockCol+"=? AND expires_at>? RETURNING id_hash"
    ).bind(rotated.accessCipher,rotated.refreshCipher,rotated.accessExpiresAt,
      rotated.refreshExpiresAt,session.hash,refreshCt,until,clock()).first();
    if(!updated)throw Error("Authorization changed during renewal; retry or reconnect");
    return grant.access_token;
  }catch{
    // Only release our own lease. A different request or logout may have
    // updated/deleted the session; never resurrect or overwrite it.
    await env.DB.prepare(
      "UPDATE onboarding_sessions SET "+lockCol+"=NULL WHERE id_hash=? AND "+refreshCol+"=? AND "+lockCol+"=?"
    ).bind(session.hash,refreshCt,until).run();
    throw Error("Provider authorization could not be renewed; reconnect or retry");
  }
}
