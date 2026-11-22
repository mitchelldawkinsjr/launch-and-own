#!/usr/bin/env node
// Operator-only website launch: pin public readiness to the exact source commit.
// Never calls this a launch until the intended GitHub revision is on production.
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {applyWebsite} from "./provision-site.mjs";
import {waitForWebsite} from "./verify-site.mjs";
import {renderSite} from "../site/render-site.mjs";
import {renderSiteBundle} from "../site/render-site-bundle.mjs";

export async function launchWebsite(input,{
  githubToken,cloudflareToken,fetchFn=fetch,
  create=applyWebsite,verify=waitForWebsite,
  attempts=18,intervalMs=15000
}={}){
  if(!githubToken||!cloudflareToken)throw Error("Authorized GitHub and Cloudflare tokens are required");
  // Compute the expected artifact before any provider mutation. A commit match alone
  // cannot prove an approved page was served byte-for-byte on the public URL.
  const assets=input?.site?.layout==="multi-page"?
    renderSiteBundle({...input.site,name:input.name}).pages:
    [{path:"public/index.html",html:renderSite({...input.site,name:input.name})}];
  const homepage=assets.find(asset=>asset.path==="public/index.html");
  if(!homepage)throw Error("Approved website has no homepage to verify");
  const expectedHtmlSha256=createHash("sha256").update(homepage.html,"utf8").digest("hex");
  const created=await create(input,{githubToken,cloudflareToken,fetchFn});
  const expectedCommitSha=created?.headCommitSha;
  if(typeof expectedCommitSha!=="string"||!/^[a-f0-9]{40}$/i.test(expectedCommitSha))
    throw Error("Provisioner returned no trustworthy GitHub commit; refusing to verify launch");
  const verified=await verify(input,{cloudflareToken,expectedCommitSha,expectedHtmlSha256,fetchFn},attempts,intervalMs);
  if(verified?.status!=="live")throw Error("Cloudflare did not verify the expected GitHub production commit");
  return {status:"live",website:verified.website,repository:created.repository,
    githubCommitSha:expectedCommitSha,approvedHomepageSha256:expectedHtmlSha256,
    deploymentId:verified.deploymentId};
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
