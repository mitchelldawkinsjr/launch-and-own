#!/usr/bin/env node
// GitHub + Cloudflare Pages website bootstrap. Safe to retry; never deletes resources.
// All mutations require --apply and scoped user-provided tokens; forms fail closed.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {planCustomer} from "./plan-customer.mjs";
import {renderSite} from "../site/render-site.mjs";
import {renderSiteBundle,siteBundleApprovalSha256} from "../site/render-site-bundle.mjs";
import {matchesApprovedPagesProject} from "./approved-pages-project.mjs";
import {isLegacyRepositoryDescription,isManagedRepositoryDescription,managedRepositoryDescription} from "./managed-site-repository.mjs";
import {ProviderRequestError} from "./provider-errors.mjs";

function checkedName(name) {
  if(!/^[a-z0-9][a-z0-9-]*$/.test(name))throw Error("Unsafe generated resource name");
  return name;
}
function requestFactory({githubToken,cloudflareToken,fetchFn=fetch,strict=false}) {
  if(!githubToken||!cloudflareToken)throw Error("GITHUB_TOKEN and CLOUDFLARE_API_TOKEN are required to apply");
  async function request(service,path,{method="GET",body,allow404=false}={}) {
    const github=service==="github";
    const base=github?"https://api.github.com":"https://api.cloudflare.com/client/v4";
    const resp=await fetchFn(base+path,{
      method,
      redirect:"manual",
      headers:{
        authorization:"Bearer "+(github?githubToken:cloudflareToken),
        accept:github?"application/vnd.github+json":"application/json",
        ...(github?{"x-github-api-version":"2022-11-28","user-agent":"launch-and-own"}:{}),
        ...(body!==undefined?{"content-type":"application/json"}:{})
      },
      ...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    if(allow404&&resp.status===404)return null;
    if(!resp.ok){
      if(strict){
        const err=new ProviderRequestError(resp,{conflictCanRetry:method==="PUT"||(github&&method==="POST")||resp.status===409});
        const need=github?resp.headers.get("x-accepted-github-permissions"):null;
        err.code=service+"_http_"+resp.status+(need?("_need_"+need.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,48)):"");
        throw err;
      }
      throw Error(service+" "+method+" "+path+" failed (HTTP "+resp.status+")");
    }
    let data;
    try{data=await resp.json()}catch{
      if(strict)throw new ProviderRequestError();
      throw Error(service+" "+method+" "+path+" returned non-JSON response");
    }
    if(!github && data.success!==true)throw Error("cloudflare "+method+" "+path+" rejected request");
    return github?data:data.result;
  }
  return {github:(path,opts)=>request("github",path,opts),cloudflare:(path,opts)=>request("cloudflare",path,opts)};
}
const isCommitSha = value => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);

async function checkStarterTree(api, repoPath, treeSha) {
  if (!isCommitSha(treeSha)) throw Error("GitHub did not return an immutable source tree");
  const tree = await api.github(repoPath + "/git/trees/" + treeSha + "?recursive=1");
  const allowed = new Map([["README.md", "100644"], ["public", "040000"], ["public/index.html", "100644"]]);
  if (tree.truncated !== false || !Array.isArray(tree.tree) ||
      tree.tree.some(entry => !allowed.has(entry.path) || allowed.get(entry.path) !== entry.mode)) {
    throw Error("Repository contains files outside the approved starter website");
  }
}

function requireApprovedHomepage(file, html) {
  if (file?.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" ||
      !Buffer.from(file.content.replace(/\s/g, ""), "base64").equals(Buffer.from(html, "utf8"))) {
    throw Error("The source revision does not contain the approved homepage");
  }
}

async function pinApprovedCommit(api, {repoPath, repository, branch, html, approved, adoptingLegacy, journal}) {
  const head = (await api.github(repoPath + "/branches/" + encodeURIComponent(branch)))?.commit;
  if (!isCommitSha(head?.sha)) throw Error("Cannot identify the GitHub source revision");
  if (approved.checkpoint && head.sha !== approved.checkpoint.headCommitSha) {
    throw Error("The default branch moved after the launch revision was recorded");
  }
  await checkStarterTree(api, repoPath, head.commit?.tree?.sha);
  const path = repoPath + "/contents/public/index.html";
  const existing = await api.github(path + "?ref=" + head.sha, {allow404:true});
  let sha = head.sha;
  if (existing || approved.checkpoint || adoptingLegacy) {
    requireApprovedHomepage(existing, html);
    journal.push({resource:"homepage",name:"public/index.html",action:"preserved"});
  } else {
    // Omitting the blob SHA permits creation and prevents replacing an existing file.
    await approved.assertCloudflareAccess();
    const created = await api.github(path, {method:"PUT",body:{
      message:"Initialize approved Launch & Own website", branch, content:Buffer.from(html,"utf8").toString("base64")
    }});
    sha = created?.commit?.sha;
    if (!isCommitSha(sha)) throw new ProviderRequestError();
    await checkStarterTree(api, repoPath, created.commit.tree?.sha);
    requireApprovedHomepage(await api.github(path + "?ref=" + sha), html);
    journal.push({resource:"homepage",name:"public/index.html",action:"created"});
  }
  // Store the immutable SHA before any request can create a Pages project.
  await approved.saveCheckpoint({repositoryId:repository.id, branch, headCommitSha:sha});
  return sha;
}
/**
 * Provision a static GitHub repository and Git-connected Pages project.
 * Only explicitly marked repositories are ever reused. Existing files are never overwritten.
 * No automatic rollback: a failed run can be safely resumed, without deleting user resources.
 */
export async function applyWebsite(input,{githubToken,cloudflareToken,fetchFn,approved}={}) {
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
  if(approved&&multiPage)throw Error("Durable onboarding approves one homepage per launch");
  if(multiPage){
    if(typeof input.approvedBundleSha256!=="string"||
      !/^[a-f0-9]{64}$/i.test(input.approvedBundleSha256))
      throw Error("Approval of the complete website bundle is required");
    const digest=await siteBundleApprovalSha256({...input.site,name:input.name});
    if(digest!==input.approvedBundleSha256.toLowerCase())
      throw Error("Website bundle differs from the exact approved preview");
  }
  const assets=multiPage?
    renderSiteBundle({...input.site,name:input.name}).pages:
    [{path:"public/index.html",html:approved?.html??renderSite({...input.site,name:input.name})}];
  const api=requestFactory({githubToken,cloudflareToken,fetchFn,strict:!!approved});
  const name=checkedName("esp-"+plan.customer);
  const pages=checkedName(name+"-site");
  const owner=plan.githubOwner;
  const repoPath="/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(name);
  const assertGitHubOwner=async()=>{
    const user=await api.github("/user");
    if(user.login?.toLowerCase()!==owner.toLowerCase()||(approved&&user.id!==approved.githubUserId))
      throw Error("Only the authenticated personal GitHub owner is supported (organization provisioning requires a separate authorization flow)");
  };
  await assertGitHubOwner();
  const originDescription=managedRepositoryDescription(plan.customer,approved?.id);
  const journal=[];
  let repository=await api.github(repoPath,{allow404:true});
  let adoptingLegacy=false;
  if(repository){
    adoptingLegacy=approved?.allowLegacy===true&&isLegacyRepositoryDescription(repository.description,plan.customer);
    const managed=approved?repository.description===originDescription||adoptingLegacy
      :isManagedRepositoryDescription(repository.description,plan.customer);
    if(!managed)
      throw Error("Existing GitHub repository is not an exact matching private pipeline-managed resource; refusing to adopt or overwrite it");
    journal.push({resource:"github-repository",name,action:"reused"});
  }else{
    if(approved?.checkpoint)throw Error("The approved repository disappeared after the launch revision was recorded");
    if(approved)await approved.assertCloudflareAccess();
    repository=await api.github("/user/repos",{method:"POST",body:{name,description:originDescription,private:true,auto_init:true}});
    journal.push({resource:"github-repository",name,action:"created"});
  }
  if(repository.owner?.login?.toLowerCase()!==owner.toLowerCase()||repository.name!==name||repository.private!==true||
     (approved&&(repository.owner?.id!==approved.githubUserId||!Number.isSafeInteger(repository.id)||repository.id<1||
       (approved.checkpoint&&repository.id!==approved.checkpoint.repositoryId))))
    throw Error("GitHub repository identity or visibility differs from the approved target");
  const branch=repository.default_branch;
  if(typeof branch!=="string"||!/^[a-zA-Z0-9._/-]+$/.test(branch))throw Error("GitHub repository has no valid default branch; repository may require initialization");
  if(approved?.checkpoint&&branch!==approved.checkpoint.branch)throw Error("The approved repository changed its default branch");
  const headCommitSha=approved
    ?await pinApprovedCommit(api,{repoPath,repository,branch,html:assets[0].html,approved,adoptingLegacy,journal})
    :await initializePages(api,{repoPath,branch,assets,checkContent:input.site!==undefined,journal});
  const cloudPath="/accounts/"+encodeURIComponent(plan.accountId)+"/pages/projects";
  const expectedProject={name:pages,owner,repositoryName:name,repositoryId:repository.id,branch};
  let project=await api.cloudflare(cloudPath+"/"+encodeURIComponent(pages),{allow404:true});
  if(project){
    const config=project.source?.config;
    if(project.source?.type!=="github"||config?.owner?.toLowerCase()!==owner.toLowerCase()||config?.repo_name!==name||String(config?.repo_id)!==String(repository.id)||project.production_branch!==branch||
       (approved&&!matchesApprovedPagesProject(project,expectedProject)))
      throw Error("Existing Pages project is not connected to the expected GitHub repository and branch; refusing to adopt it");
    journal.push({resource:"cloudflare-pages",name:pages,action:"reused"});
  }else{
    if(approved){
      // Recheck the grant and branch immediately before asking Pages to build.
      await assertGitHubOwner();
      const head=await api.github(repoPath+"/branches/"+encodeURIComponent(branch));
      if(head?.commit?.sha!==headCommitSha)throw Error("GitHub branch moved before Pages creation");
    }
    project=await api.cloudflare(cloudPath,{method:"POST",body:{
      name:pages,production_branch:branch,
      source:{type:"github",config:{owner,repo_name:name,production_branch:branch,production_deployments_enabled:true,preview_deployment_setting:approved?"none":"all"}},
      build_config:{build_command:"",destination_dir:"public",root_dir:"/"}
    }});
    if(approved&&!matchesApprovedPagesProject(project,expectedProject))
      throw Error("Pages did not confirm the approved project configuration");
    journal.push({resource:"cloudflare-pages",name:pages,action:"created"});
  }
  // Provisioning does NOT imply successful deployment or DNS propagation.
  return {status:"awaiting-live-deployment-verification",repository:"https://github.com/"+owner+"/"+name,
    website:"https://"+pages+".pages.dev",project:pages,branch,headCommitSha,journal,forms:false,pageCount:assets.length,
    ...(approved?{pagesProjectId:project.id}:{})};
}

async function initializePages(api,{repoPath,branch,assets,checkContent,journal}) {
  // Preflight EVERY page before writing ANY page: partial retries may safely
  // resume, but a collision in a later page must never cause earlier writes.
  const pageFiles=[];
  for(const asset of assets){
    const path=repoPath+"/contents/"+asset.path;
    const existingFile=await api.github(path,{allow404:true});
    if(existingFile){
      if(existingFile.type!=="file")
        throw Error("Expected website page is not a file; refusing to overwrite it");
      if(checkContent){
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
  if(!isCommitSha(headCommitSha))
    throw Error("Cannot determine the expected GitHub deployment commit; refusing to claim launch readiness");
  return headCommitSha;
}
export function previewWebsite(input) {
  const plan=planCustomer(input);
  return {...plan, pageCount:input.site?.layout==="multi-page"?4:1,
    requiresBundleApproval:input.site?.layout==="multi-page", executable:!plan.forms&&!input.hostname, note:plan.forms?"Forms provisioning is gated until Worker/Access setup and live acceptance are automated":input.hostname?"Custom-domain attachment is not yet automated":"Use --apply with authorized account tokens to create/reuse a private repository and connected Pages project"};
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
