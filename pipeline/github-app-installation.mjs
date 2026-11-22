// Confirm the GitHub App is installed on the signed-in personal account with
// repository-creation rights. User OAuth alone does not grant that permission.
import {ProviderRequestError} from "./provider-errors.mjs";

const SLUG=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function githubAppInstallUrl(appSlug){
  if(typeof appSlug!=="string"||!SLUG.test(appSlug))throw Error("GitHub App slug is required");
  return "https://github.com/apps/"+appSlug+"/installations/new";
}

export async function githubAppCanCreateRepositories({
  accessToken,appSlug,githubLogin,fetchFn=fetch
}={}){
  if(typeof accessToken!=="string"||!accessToken)throw Error("GitHub access token is required");
  if(typeof appSlug!=="string"||!SLUG.test(appSlug))throw Error("GitHub App slug is required");
  if(typeof githubLogin!=="string"||!githubLogin)throw Error("GitHub login is required");
  const resp=await fetchFn("https://api.github.com/user/installations?per_page=100",{
    method:"GET",
    headers:{
      authorization:"Bearer "+accessToken,
      accept:"application/vnd.github+json",
      "x-github-api-version":"2022-11-28",
      "user-agent":"launch-and-own"
    },
    redirect:"manual"
  });
  if(!resp.ok){
    const err=new ProviderRequestError(resp);
    err.code="github_http_"+resp.status;
    throw err;
  }
  const data=await resp.json();
  const installations=Array.isArray(data.installations)?data.installations:[];
  const login=githubLogin.toLowerCase();
  return installations.some(install=>
    install?.app_slug===appSlug&&
    install?.account?.type==="User"&&
    install?.account?.login?.toLowerCase()===login&&
    (install?.permissions?.repository_creation==="write"||
      install?.permissions?.administration==="write")
  );
}
