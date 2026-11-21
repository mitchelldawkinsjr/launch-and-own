#!/usr/bin/env node
// GitHub + Cloudflare Pages website bootstrap. Safe to retry; never deletes resources.
// All mutations require --apply and scoped user-provided tokens; forms fail closed.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {planCustomer} from "./plan-customer.mjs";
import {renderSite} from "../site/render-site.mjs";
import {renderSiteBundle} from "../site/render-site-bundle.mjs";

const mark = slug => "Launch & Own managed site: "+slug;
// Preserve safe retries for previously provisioned beta sites with the original ownership marker.
const legacyMark = slug => "Elite Site Pipeline managed site: "+slug;
function checkedName(name) {
  if(!/^[a-z0-9][a-z0-9-]*$/.test(name))throw Error("Unsafe generated resource name");
  return name;
}
function requestFactory({githubToken,cloudflareToken,fetchFn=fetch}) {
  if(!githubToken||!cloudflareToken)throw Error("GITHUB_TOKEN and CLOUDFLARE_API_TOKEN are required to apply");
  async function request(service,path,{method="GET",body,allow404=false}={}) {
    const github=service==="github";
    const base=github?"https://api.github.com":"https://api.cloudflare.com/client/v4";
    const resp=await fetchFn(base+path,{
      method,
      headers:{
        authorization:"Bearer "+(github?githubToken:cloudflareToken),
        accept:github?"application/vnd.github+json":"application/json",
        ...(github?{"x-github-api-version":"2022-11-28"}:{}),
        ...(body!==undefined?{"content-type":"application/json"}:{})
      },
      ...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    if(allow404&&resp.status===404)return null;
    if(!resp.ok)throw Error(service+" "+method+" "+path+" failed (HTTP "+resp.status+")");
    let data;
    try{data=await resp.json()}catch{throw Error(service+" "+method+" "+path+" returned non-JSON response")}
    if(!github && data.success!==true)throw Error("cloudflare "+method+" "+path+" rejected request");
    return github?data:data.result;
  }
  return {github:(path,opts)=>request("github",path,opts),cloudflare:(path,opts)=>request("cloudflare",path,opts)};
}
/**
 * Provision a static GitHub repository and Git-connected Pages project.
 * Only explicitly marked repositories are ever reused. Existing files are never overwritten.
 * No automatic rollback: a failed run can be safely resumed, without deleting user resources.
 */
export async function applyWebsite(input,{githubToken,cloudflareToken,fetchFn}={}) {
  const plan=planCustomer(input);
  if(plan.forms)throw Error("Form provisioning is not yet automated; no resources were changed");
  if(input.hostname)throw Error("Custom domain attachment is not yet automated; no resources were changed");
  if(input.site!==undefined&&(!input.site||typeof input.site!=="object"||Array.isArray(input.site)))
    throw Error("Website content must be an object");
  // Render and validate before any provider mutation. The generated HTML is
  // the identical artifact the customer previewed and approved.
  const multiPage=input.site?.layout==="multi-page";
  if(input.site?.layout!==undefined&&!multiPage)
    throw Error("Unsupported website layout");
  const assets=multiPage?
    renderSiteBundle({...input.site,name:input.name}).pages:
    [{path:"public/index.html",html:renderSite({...input.site,name:input.name})}];
  const homepageHtml=assets[0].html;
  const api=requestFactory({githubToken,cloudflareToken,fetchFn});
  const name=checkedName("esp-"+plan.customer);
  const pages=checkedName(name+"-site");
  const owner=plan.githubOwner;
  const repoPath="/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(name);
  const user=await api.github("/user");
  if(user.login?.toLowerCase()!==owner.toLowerCase())throw Error("Only the authenticated personal GitHub owner is supported (organization provisioning requires a separate authorization flow)");
  const originDescription=mark(plan.customer);
  const journal=[];
  let repository=await api.github(repoPath,{allow404:true});
  if(repository){
    if(repository.owner?.login?.toLowerCase()!==owner.toLowerCase()||repository.name!==name||![originDescription,legacyMark(plan.customer)].includes(repository.description)||repository.private!==true)
      throw Error("Existing GitHub repository is not an exact matching private pipeline-managed resource; refusing to adopt or overwrite it");
    journal.push({resource:"github-repository",name,action:"reused"});
  }else{
    repository=await api.github("/user/repos",{method:"POST",body:{name,description:originDescription,private:true,auto_init:true}});
    journal.push({resource:"github-repository",name,action:"created"});
  }
  const branch=repository.default_branch;
  if(typeof branch!=="string"||!/^[a-zA-Z0-9._/-]+$/.test(branch))throw Error("GitHub repository has no valid default branch; repository may require initialization");
  // Preflight EVERY page before writing ANY page: partial retries may safely
  // resume, but a collision in a later page must never cause earlier writes.
  const pageFiles=[];
  for(const asset of assets){
    const path=repoPath+"/contents/"+asset.path;
    const existingFile=await api.github(path,{allow404:true});
    if(existingFile){
      if(existingFile.type!=="file")
        throw Error("Expected website page is not a file; refusing to overwrite it");
      if(input.site!==undefined){
        if(existingFile.encoding!=="base64"||typeof existingFile.content!=="string")
          throw Error("Existing website page cannot be verified against approved content");
        const existingHtml=Buffer.from(existingFile.content.replace(/\s/g,""),"base64").toString("utf8");
        if(existingHtml!==asset.html)
          throw Error("Existing website page differs from the approved preview; refusing to reuse it");
      }
    }
    pageFiles.push({asset,path,exists:!!existingFile});
  }
  for(const item of pageFiles){
    const resource=item.asset.path==="public/index.html"?"homepage":"site-page";
    if(item.exists){
      journal.push({resource,name:item.asset.path,action:"preserved"});
      continue;
    }
    await api.github(item.path,{method:"PUT",body:{
      message:"Initialize approved "+item.asset.path+" for Cloudflare Pages",
      branch,content:Buffer.from(item.asset.html,"utf8").toString("base64")
    }});
    journal.push({resource,name:item.asset.path,action:"created"});
  }
  // Tie launch acceptance to an exact GitHub revision, never just a live Pages URL.
  const headInfo=await api.github(repoPath+"/branches/"+encodeURIComponent(branch));
  const headCommitSha=headInfo?.commit?.sha;
  if(typeof headCommitSha!=="string"||!/^[a-f0-9]{40}$/i.test(headCommitSha))
    throw Error("Cannot determine the expected GitHub deployment commit; refusing to claim launch readiness");
  const cloudPath="/accounts/"+encodeURIComponent(plan.accountId)+"/pages/projects";
  let project=await api.cloudflare(cloudPath+"/"+encodeURIComponent(pages),{allow404:true});
  if(project){
    const config=project.source?.config;
    if(project.source?.type!=="github"||config?.owner?.toLowerCase()!==owner.toLowerCase()||config?.repo_name!==name||String(config?.repo_id)!==String(repository.id)||project.production_branch!==branch)
      throw Error("Existing Pages project is not connected to the expected GitHub repository and branch; refusing to adopt it");
    journal.push({resource:"cloudflare-pages",name:pages,action:"reused"});
  }else{
    project=await api.cloudflare(cloudPath,{method:"POST",body:{
      name:pages,production_branch:branch,
      source:{type:"github",config:{owner,repo_name:name,production_branch:branch,production_deployments_enabled:true,preview_deployment_setting:"all"}},
      build_config:{build_command:"",destination_dir:"public",root_dir:"/"}
    }});
    journal.push({resource:"cloudflare-pages",name:pages,action:"created"});
  }
  // Provisioning does NOT imply successful deployment or DNS propagation.
  return {status:"awaiting-live-deployment-verification",repository:"https://github.com/"+owner+"/"+name,
    website:"https://"+pages+".pages.dev",project:pages,branch,headCommitSha,journal,forms:false,pageCount:assets.length};
}
export function previewWebsite(input) {
  const plan=planCustomer(input);
  return {...plan, pageCount:input.site?.layout==="multi-page"?4:1, executable:!plan.forms&&!input.hostname, note:plan.forms?"Forms provisioning is gated until Worker/Access setup and live acceptance are automated":input.hostname?"Custom-domain attachment is not yet automated":"Use --apply with authorized account tokens to create/reuse a private repository and connected Pages project"};
}
async function main(args=process.argv.slice(2)) {
  const apply=args.includes("--apply");
  const positional=args.filter(a=>a!=="--apply");
  if(positional.length!==1)throw Error("Usage: node pipeline/provision-site.mjs customer.json [--apply]");
  const input=JSON.parse(readFileSync(positional[0],"utf8"));
  if(!apply){console.log(JSON.stringify(previewWebsite(input),null,2));return}
  const result=await applyWebsite(input,{githubToken:process.env.GITHUB_TOKEN,cloudflareToken:process.env.CLOUDFLARE_API_TOKEN});
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(e=>{console.error("Provisioning stopped safely:",e.message);process.exitCode=1});
}
