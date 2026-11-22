// Read-only connection preflight for a trusted onboarding backend.
// Real user identity and account access MUST be checked by provider APIs; do not trust UI booleans.
import {planCustomer} from "./plan-customer.mjs";
import {verifyCloudflareAccount} from "./cloudflare-oauth.mjs";
import {ProviderRequestError} from "./provider-errors.mjs";

export async function verifyProviderConnections(input,{githubAccessToken,cloudflareAccessToken,fetchFn=fetch,expectedGitHubUserId}={}) {
  const plan=planCustomer(input);
  if(plan.forms||input.hostname)throw Error("This onboarding preflight only supports website-only pages.dev sites");
  if(typeof githubAccessToken!=="string"||!githubAccessToken||typeof cloudflareAccessToken!=="string"||!cloudflareAccessToken)
    throw Error("GitHub and Cloudflare connections are both required");
  const resp=await fetchFn("https://api.github.com/user",{method:"GET",headers:{
    authorization:"Bearer "+githubAccessToken,
    accept:"application/vnd.github+json",
    "x-github-api-version":"2022-11-28",
    "user-agent":"launch-and-own"
  },redirect:"manual"});
  const strict=expectedGitHubUserId!==undefined;
  if(!resp.ok){
    if(strict){
      const err=new ProviderRequestError(resp);
      const need=resp.headers.get("x-accepted-github-permissions");
      err.code="github_http_"+resp.status+(need?("_need_"+need.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,48)):"");
      throw err;
    }
    throw Error("GitHub authorization is unavailable (HTTP "+resp.status+")");
  }
  const user=await resp.json();
  if(typeof user.login!=="string"||user.login.toLowerCase()!==plan.githubOwner.toLowerCase()||
      (strict&&user.id!==expectedGitHubUserId))
    throw Error("Connected GitHub user is not the selected repository owner");
  const account=await verifyCloudflareAccount({accessToken:cloudflareAccessToken,accountId:plan.accountId,fetchFn,strict});
  return {status:"identities-verified",githubOwner:user.login,githubUserId:user.id,
    cloudflareAccountId:account.id,cloudflareAccountName:account.name,
    provisioningStatus:"not-started",githubPagesIntegration:"not-verified"};
}
