// Provider-side OAuth disconnect for a Launch & Own customer session.
// Never log provider responses, tokens or client secrets. Always remove local
// session credentials even if a remote provider cannot be reached.
const required=(value,label)=>{
  if(typeof value!=="string"||!value)throw Error(label+" is required");
  return value;
};
const requestWithTimeout=(fetchFn,url,options)=>fetchFn(url,{...options,signal:AbortSignal.timeout(8000)});
export async function revokeGitHubGrant({clientId,clientSecret,accessToken,fetchFn=fetch}){
  required(clientId,"GitHub client ID");
  required(clientSecret,"GitHub client secret");
  required(accessToken,"GitHub access token");
  const r=await requestWithTimeout(fetchFn,"https://api.github.com/applications/"+encodeURIComponent(clientId)+"/grant",{
    method:"DELETE",redirect:"manual",headers:{
      authorization:"Basic "+Buffer.from(clientId+":"+clientSecret).toString("base64"),
      accept:"application/vnd.github+json",
      "x-github-api-version":"2022-11-28",
      "user-agent":"launch-and-own",
      "content-type":"application/json"
    },body:JSON.stringify({access_token:accessToken})
  });
  if(r.status!==204)throw Error("GitHub authorization revocation was not confirmed");
  return true;
}
export async function revokeCloudflareToken({clientId,clientSecret,accessToken,fetchFn=fetch}){
  required(clientId,"Cloudflare client ID");
  required(clientSecret,"Cloudflare client secret");
  required(accessToken,"Cloudflare access token");
  const r=await requestWithTimeout(fetchFn,"https://dash.cloudflare.com/oauth2/revoke",{
    method:"POST",redirect:"manual",headers:{
      authorization:"Basic "+Buffer.from(clientId+":"+clientSecret).toString("base64"),
      "content-type":"application/x-www-form-urlencoded",
      accept:"application/json"
    },body:new URLSearchParams({token:accessToken,token_type_hint:"access_token"}).toString()
  });
  if(!r.ok)throw Error("Cloudflare authorization revocation was not confirmed");
  return true;
}
export async function revokeConnectedAccounts({githubToken,cloudflareToken,ghClientId,ghClientSecret,cfClientId,cfClientSecret,fetchFn=fetch}){
  // Concurrent failures must never block the local session logout. Return only
  // status codes, not exception bodies or user credentials.
  const tasks=[
    typeof githubToken==="string"&&githubToken?
      revokeGitHubGrant({clientId:ghClientId,clientSecret:ghClientSecret,accessToken:githubToken,fetchFn}):null,
    typeof cloudflareToken==="string"&&cloudflareToken?
      revokeCloudflareToken({clientId:cfClientId,clientSecret:cfClientSecret,accessToken:cloudflareToken,fetchFn}):null
  ];
  const results=await Promise.all(tasks.map(task=>task===null?Promise.resolve("not-connected"):task.then(()=> "revoked",()=> "unconfirmed")));
  return {github:results[0],cloudflare:results[1],fullyRevoked:results.every(x=>x!=="unconfirmed")};
}
