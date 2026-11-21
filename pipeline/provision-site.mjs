#!/usr/bin/env node
// GitHub + Cloudflare Pages website bootstrap. Safe to retry; never deletes resources.
// All mutations require --apply and scoped user-provided tokens; forms fail closed.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {planCustomer} from "./plan-customer.mjs";

const mark = slug => "Launch & Own managed site: "+slug;
// Preserve safe retries for previously provisioned beta sites with the original ownership marker.
const legacyMark = slug => "Elite Site Pipeline managed site: "+slug;
const safeHtml = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const homepage = name => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${safeHtml(name)} website"><title>${safeHtml(name)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:18px/1.6 system-ui,sans-serif;color:#17233d;background:#f7f9fc}main{max-width:640px;margin:24px;padding:48px;border:1px solid #dce5ee;border-radius:20px;background:white}h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.15}p{color:#52627a}</style></head>
<body><main><h1>${safeHtml(name)}</h1><p>Welcome! This site is ready for your content.</p></main></body></html>
`;
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
  const filePath=repoPath+"/contents/public/index.html";
  const existingFile=await api.github(filePath,{allow404:true});
  if(existingFile){
    if(existingFile.type!=="file")throw Error("Expected homepage path is not a file; stopping without replacing it");
    journal.push({resource:"homepage",name:"public/index.html",action:"preserved"});
  }else{
    await api.github(filePath,{method:"PUT",body:{message:"Initialize website for Cloudflare Pages",branch,content:Buffer.from(homepage(input.name),"utf8").toString("base64")}});
    journal.push({resource:"homepage",name:"public/index.html",action:"created"});
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
    website:"https://"+pages+".pages.dev",project:pages,branch,headCommitSha,journal,forms:false};
}
export function previewWebsite(input) {
  const plan=planCustomer(input);
  return {...plan, executable:!plan.forms&&!input.hostname, note:plan.forms?"Forms provisioning is gated until Worker/Access setup and live acceptance are automated":input.hostname?"Custom-domain attachment is not yet automated":"Use --apply with authorized account tokens to create/reuse a private repository and connected Pages project"};
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
