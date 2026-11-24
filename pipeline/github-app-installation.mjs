// Confirm the GitHub App is installed on the signed-in personal account with
// repository-creation rights. User OAuth alone does not grant that permission.
import {ProviderRequestError} from "./provider-errors.mjs";

const SLUG=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Cloudflare's separate app that Pages uses to read the customer's GitHub folder.
 *  Launch & Own user-to-server tokens cannot list this install; treat UI links as guidance. */
export const CLOUDFLARE_WORKERS_PAGES_APP_SLUG="cloudflare-workers-and-pages";

export function githubAppInstallUrl(appSlug){
  if(typeof appSlug!=="string"||!SLUG.test(appSlug))throw Error("GitHub App slug is required");
  return "https://github.com/apps/"+appSlug+"/installations/new";
}

function matchingUserInstall(installations,appSlug,githubLogin){
  const login=githubLogin.toLowerCase();
  return installations.find(install=>
    install?.app_slug===appSlug&&
    install?.account?.type==="User"&&
    install?.account?.login?.toLowerCase()===login
  )||null;
}

export async function listUserGithubAppInstallations({accessToken,fetchFn=fetch}={}){
  if(typeof accessToken!=="string"||!accessToken)throw Error("GitHub access token is required");
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
  return Array.isArray(data.installations)?data.installations:[];
}

export function githubAppInstalledOnUser({installations,appSlug,githubLogin}={}){
  if(!Array.isArray(installations))throw Error("GitHub installations list is required");
  if(typeof appSlug!=="string"||!SLUG.test(appSlug))throw Error("GitHub App slug is required");
  if(typeof githubLogin!=="string"||!githubLogin)throw Error("GitHub login is required");
  return matchingUserInstall(installations,appSlug,githubLogin)!==null;
}

export async function githubAppCanCreateRepositories({
  accessToken,appSlug,githubLogin,fetchFn=fetch,installations
}={}){
  if(typeof appSlug!=="string"||!SLUG.test(appSlug))throw Error("GitHub App slug is required");
  if(typeof githubLogin!=="string"||!githubLogin)throw Error("GitHub login is required");
  const list=installations??await listUserGithubAppInstallations({accessToken,fetchFn});
  const install=matchingUserInstall(list,appSlug,githubLogin);
  return Boolean(install&&
    (install.permissions?.repository_creation==="write"||
      install.permissions?.administration==="write"));
}
