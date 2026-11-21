#!/usr/bin/env node
// Operator-only website launch: pin public readiness to the exact source commit.
// Never calls this a launch until the intended GitHub revision is on production.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {applyWebsite} from "./provision-site.mjs";
import {waitForWebsite} from "./verify-site.mjs";

export async function launchWebsite(input,{
  githubToken,cloudflareToken,fetchFn=fetch,
  create=applyWebsite,verify=waitForWebsite,
  attempts=18,intervalMs=15000
}={}){
  if(!githubToken||!cloudflareToken)throw Error("Authorized GitHub and Cloudflare tokens are required");
  const created=await create(input,{githubToken,cloudflareToken,fetchFn});
  const expectedCommitSha=created?.headCommitSha;
  if(typeof expectedCommitSha!=="string"||!/^[a-f0-9]{40}$/i.test(expectedCommitSha))
    throw Error("Provisioner returned no trustworthy GitHub commit; refusing to verify launch");
  const verified=await verify(input,{cloudflareToken,expectedCommitSha,fetchFn},attempts,intervalMs);
  if(verified?.status!=="live")throw Error("Cloudflare did not verify the expected GitHub production commit");
  return {status:"live",website:verified.website,repository:created.repository,
    githubCommitSha:expectedCommitSha,deploymentId:verified.deploymentId};
}
async function main(args=process.argv.slice(2)){
  if(args.length!==1)throw Error("Usage: node pipeline/launch-site.mjs customer.json");
  const input=JSON.parse(readFileSync(args[0],"utf8"));
  const result=await launchWebsite(input,{
    githubToken:process.env.GITHUB_TOKEN,cloudflareToken:process.env.CLOUDFLARE_API_TOKEN
  });
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(e=>{console.error("Launch is not verified:",e.message);process.exitCode=1});
}
