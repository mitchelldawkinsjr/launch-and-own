#!/usr/bin/env node
// Verification of a customer Pages production deployment and its public homepage.
// Its only write: start the first build of an approved project that has never deployed.
// expectedProject pins an existing site for status checks without the first-build authority.
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {planCustomer} from "./plan-customer.mjs";
import {matchesApprovedPagesProject} from "./approved-pages-project.mjs";
import {ProviderRequestError} from "./provider-errors.mjs";

export async function responseMatchesBytes(response, expected) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return offset === expected.length;
      if (value.length > expected.length - offset ||
          value.some((byte, index) => byte !== expected[offset + index])) return false;
      offset += value.length;
    }
  } finally {
    await reader.cancel();
  }
}

async function assertApprovedGitHubHead(plan, {githubToken, expectedCommitSha, approved, fetchFn}) {
  if(!githubToken||!Number.isSafeInteger(approved.githubUserId)||approved.githubUserId<1)
    throw Error("The approved GitHub owner is required to start the first Pages build");
  const repoName="esp-"+plan.customer;
  const repoUrl="https://api.github.com/repos/"+encodeURIComponent(plan.githubOwner)+"/"+encodeURIComponent(repoName);
  const headers={authorization:"Bearer "+githubToken,accept:"application/vnd.github+json",
    "x-github-api-version":"2022-11-28","user-agent":"launch-and-own"};
  async function readGitHub(url) {
    const response=await fetchFn(url,{method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(15000)});
    if(!response.ok){
      const error=new ProviderRequestError(response);
      error.code="github_http_"+response.status;
      throw error;
    }
    return response.json().catch(()=>{throw new ProviderRequestError()});
  }
  const repository=await readGitHub(repoUrl);
  if(repository?.id!==approved.repositoryId||repository.owner?.id!==approved.githubUserId||
     repository.owner?.login?.toLowerCase()!==plan.githubOwner.toLowerCase()||repository.name!==repoName||
     repository.private!==true||repository.default_branch!==approved.branch)
    throw Error("GitHub repository differs from the approved first-build source");
  const head=await readGitHub(repoUrl+"/branches/"+encodeURIComponent(approved.branch));
  if(head?.commit?.sha?.toLowerCase()!==expectedCommitSha.toLowerCase())
    throw Error("GitHub branch moved before the first Pages build");
}

export async function verifyWebsite(input,{cloudflareToken,githubToken,expectedCommitSha,expectedHtmlSha256,
  fetchFn=fetch,approved,expectedProject}={}) {
  const plan=planCustomer(input);
  if(plan.forms||input.hostname)throw Error("This verifier currently supports only website-only pages.dev projects");
  if(!cloudflareToken)throw Error("CLOUDFLARE_API_TOKEN is required for deployment verification");
  if(expectedProject&&(approved||typeof expectedProject.projectId!=="string"||!expectedProject.projectId||
      typeof expectedProject.branch!=="string"||!expectedProject.branch||
      !Number.isSafeInteger(expectedProject.repositoryId)||expectedProject.repositoryId<1||
      !Number.isSafeInteger(expectedProject.githubUserId)||expectedProject.githubUserId<1))
    throw Error("Read-only verification needs the verified Pages and GitHub identities");
  const target=approved??expectedProject;
  if((target||expectedCommitSha!==undefined)&&(typeof expectedCommitSha!=="string"||!/^[a-f0-9]{40}$/i.test(expectedCommitSha)))
    throw Error("Expected commit SHA must be a full 40-character GitHub commit hash");
  if((expectedProject||expectedHtmlSha256!==undefined)&&(typeof expectedHtmlSha256!=="string"||!/^[a-f0-9]{64}$/i.test(expectedHtmlSha256)))
    throw Error("Expected HTML SHA-256 must be a full 64-character digest");
  const projectName="esp-"+plan.customer+"-site";
  const website="https://"+projectName+".pages.dev";
  const apiUrl="https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(plan.accountId)+"/pages/projects/"+encodeURIComponent(projectName);
  const response=await fetchFn(apiUrl,{headers:{authorization:"Bearer "+cloudflareToken,accept:"application/json"},redirect:"manual",signal:AbortSignal.timeout(15000)});
  if(!response.ok){
    if(approved)throw new ProviderRequestError(response);
    throw Error("Could not read Pages project (HTTP "+response.status+")");
  }
  const data=await response.json().catch(error=>{
    if(approved)throw new ProviderRequestError();
    throw error;
  });
  if(!data.success||!data.result)throw Error("Cloudflare did not return a Pages project");
  const project=data.result;
  const source=project.source;
  if(!target&&(project.name!==projectName||source?.type!=="github"||typeof source.config?.owner!=="string"||
      source.config.owner.toLowerCase()!==plan.githubOwner.toLowerCase()||source.config?.repo_name!=="esp-"+plan.customer))
    throw Error("Project ownership or GitHub source mismatch; refusing to verify an unrelated deployment");
  if(target&&!matchesApprovedPagesProject(project,{name:projectName,owner:plan.githubOwner,
      ownerId:target.githubUserId,repositoryName:"esp-"+plan.customer,repositoryId:target.repositoryId,
      branch:target.branch,projectId:target.projectId}))
    throw Error("Pages source or build settings differ from the approved project");
  // Pages builds on pushes made after the project exists. The approved commit lands
  // before the project is created, so nothing ever starts the first build on its own.
  if(approved&&!project.canonical_deployment&&!project.latest_deployment){
    // The Git-backed deployment API uses current branch HEAD. Its commit_hash field
    // describes a revision and does not offer an expected-head precondition.
    await assertApprovedGitHubHead(plan,{githubToken,expectedCommitSha,approved,fetchFn});
    const form=new FormData();form.set("branch",approved.branch);
    const start=await fetchFn(apiUrl+"/deployments",{method:"POST",headers:{authorization:"Bearer "+cloudflareToken,accept:"application/json"},
      body:form,redirect:"manual",signal:AbortSignal.timeout(15000)});
    if(!start.ok)throw new ProviderRequestError(start);
    return {status:"pending-deployment",website,project:projectName,latestStage:"queued",latestStatus:"started"};
  }
  const canonical=project.canonical_deployment;
  const latest=project.latest_deployment;
  const stage=canonical?.latest_stage;
  const latestStage=latest?.latest_stage;
  const production=canonical?.environment==="production"||
    (!approved&&expectedHtmlSha256===undefined&&canonical?.environment==null);
  if(stage?.name!=="deploy"||stage?.status!=="success"||!production)
    return {status:"pending-deployment",website,project:projectName,latestStage:latestStage?.name||null,latestStatus:latestStage?.status||null};
  // A previously live deployment does not prove the newly approved revision is live.
  // Cloudflare exposes the GitHub revision on the canonical production deployment.
  const deployedCommit=canonical?.deployment_trigger?.metadata?.commit_hash||null;
  if(expectedCommitSha&&deployedCommit?.toLowerCase()!==expectedCommitSha.toLowerCase())
    return {status:"pending-expected-commit",website,project:projectName,expectedCommit:expectedCommitSha,deployedCommit};
  const page=await fetchFn(website+"/",{method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000)});
  if(page.status!==200)
    return {status:"pending-public-reachability",website,project:projectName,httpStatus:page.status};
  const contentType=page.headers.get("content-type")||"";
  if(!/text\/html\b/i.test(contentType))
    return {status:"unexpected-public-content",website,project:projectName,contentType};
  let homepageBytes;
  try{
    if(approved){
      const expectedBytes=approved.htmlBytes??new TextEncoder().encode(approved.html);
      if(await responseMatchesBytes(page,expectedBytes))homepageBytes=expectedBytes;
    }else{
      homepageBytes=new Uint8Array(await page.arrayBuffer());
    }
  }catch(error){
    if(approved)throw new ProviderRequestError();
    throw error;
  }
  if(!homepageBytes||(!approved?.htmlBytes&&!/<html\b/i.test(new TextDecoder().decode(homepageBytes))))
    return {status:"unexpected-public-content",website,project:projectName,contentType};
  const publicHtmlSha256=createHash("sha256").update(homepageBytes).digest("hex");
  if(expectedHtmlSha256&&publicHtmlSha256!==expectedHtmlSha256.toLowerCase())
    return {status:"pending-expected-html",website,project:projectName,
      expectedHtmlSha256:expectedHtmlSha256.toLowerCase(),publicHtmlSha256};
  return {status:"live",website,project:projectName,deploymentId:canonical.id,publicHtmlSha256,
    latestPending:latest?.id!==canonical.id&&latestStage?.status!=="success"};
}
export async function waitForWebsite(input,options={},attempts=18,intervalMs=15000) {
  if(!Number.isInteger(attempts)||attempts<1||attempts>30)throw Error("attempts must be 1-30");
  if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw Error("intervalMs must be 1000-60000");
  let result;
  for(let i=0;i<attempts;i++){
    result=await verifyWebsite(input,options);
    if(result.status==="live")return {...result,attempts:i+1};
    if(result.status==="unexpected-public-content")throw Error("Public URL returned unexpected content");
    if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }
  throw Error("Deployment not verified after "+attempts+" checks (last status: "+result.status+")");
}
async function main(args=process.argv.slice(2)){
  if(args.length!==1)throw Error("Usage: node pipeline/verify-site.mjs customer.json");
  const input=JSON.parse(readFileSync(args[0],"utf8"));
  const result=await waitForWebsite(input,{cloudflareToken:process.env.CLOUDFLARE_API_TOKEN});
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{console.error("Website launch verification failed:",e.message);process.exitCode=1});
}
