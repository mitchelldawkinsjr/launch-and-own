#!/usr/bin/env node
// Read-only verification of a customer Pages production deployment and its public homepage.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {planCustomer} from "./plan-customer.mjs";

export async function verifyWebsite(input,{cloudflareToken,expectedCommitSha,fetchFn=fetch}={}) {
  const plan=planCustomer(input);
  if(plan.forms||input.hostname)throw Error("This verifier currently supports only website-only pages.dev projects");
  if(!cloudflareToken)throw Error("CLOUDFLARE_API_TOKEN is required for deployment verification");
  if(expectedCommitSha!==undefined&&(typeof expectedCommitSha!=="string"||!/^[a-f0-9]{40}$/i.test(expectedCommitSha)))
    throw Error("Expected commit SHA must be a full 40-character GitHub commit hash");
  const projectName="esp-"+plan.customer+"-site";
  const website="https://"+projectName+".pages.dev";
  const apiUrl="https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(plan.accountId)+"/pages/projects/"+encodeURIComponent(projectName);
  const response=await fetchFn(apiUrl,{headers:{authorization:"Bearer "+cloudflareToken,accept:"application/json"},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error("Could not read Pages project (HTTP "+response.status+")");
  const data=await response.json();
  if(!data.success||!data.result)throw Error("Cloudflare did not return a Pages project");
  const project=data.result;
  const source=project.source;
  if(project.name!==projectName||source?.type!=="github"||source.config?.owner?.toLowerCase()!==plan.githubOwner.toLowerCase()||source.config?.repo_name!=="esp-"+plan.customer)
    throw Error("Project ownership or GitHub source mismatch; refusing to verify an unrelated deployment");
  const canonical=project.canonical_deployment;
  const latest=project.latest_deployment;
  const stage=canonical?.latest_stage;
  const latestStage=latest?.latest_stage;
  if(stage?.name!=="deploy"||stage?.status!=="success")
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
  const body=await page.text();
  if(!/<html\b/i.test(body))
    return {status:"unexpected-public-content",website,project:projectName,contentType};
  return {status:"live",website,project:projectName,deploymentId:canonical.id,
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
