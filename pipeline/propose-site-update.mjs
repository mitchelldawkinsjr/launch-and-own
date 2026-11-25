// Propose a customer-approved website update on a GitHub feature branch.
// Never overwrite a live default branch or claim that the PR is deployed.
// Requires a separate caller-controlled human approval and exact preview hash.
import {planCustomer} from "./plan-customer.mjs";
import {renderSite} from "../site/render-site.mjs";
import {isManagedRepositoryDescription} from "./managed-site-repository.mjs";
import {gitBlobSha} from "./reviewed-homepage-revert.mjs";

const SHA=/^[a-f0-9]{40}$/i;
const DIGEST=/^[a-f0-9]{64}$/i;
const encode=x=>encodeURIComponent(x);
const bodyMax=4096;
const HOMEPAGE="public/index.html";

async function digest(text){
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
function details(input){
  if(input?.forms||input?.hostname)throw Error("Site updates support static template content only; forms and domains cannot be modified");
  const plan=planCustomer(input);
  if(!input.site||typeof input.site!=="object"||Array.isArray(input.site))
    throw Error("Proposed website content is required");
  const html=renderSite({...input.site,name:input.name},{contactForm:input.contactForm});
  return {plan,html};
}
export async function previewWebsiteUpdate(input){
  const {plan,html}=details(input);
  return {
    status:"preview-only",html,htmlSha256:await digest(html),
    githubOwner:plan.githubOwner,repository:"esp-"+plan.customer,
    note:"Preview and approve this exact HTML and current main commit before proposing a pull request. This function makes no provider requests."
  };
}
function githubClient({token,fetchFn=fetch}){
  if(typeof token!=="string"||!token)throw Error("Authenticated GitHub user access is required");
  return async (path,{method="GET",body,allow404=false}={})=>{
    const response=await fetchFn("https://api.github.com"+path,{
      method,redirect:"manual",
      headers:{authorization:"Bearer "+token,accept:"application/vnd.github+json","x-github-api-version":"2022-11-28","user-agent":"launch-and-own",
        ...(body!==undefined?{"content-type":"application/json"}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    if(allow404&&response.status===404)return null;
    if(!response.ok)throw Error("GitHub "+method+" could not finish the approved update (HTTP "+response.status+")");
    try{return await response.json()}catch{throw Error("GitHub returned an unexpected response to the approved update")}
  };
}
function fileContent(file){
  if(file?.type!=="file"||file.encoding!=="base64"||typeof file.content!=="string"||
     typeof file.sha!=="string"||!SHA.test(file.sha))
    throw Error("GitHub homepage file is not a verifiable content blob");
  return Buffer.from(file.content.replace(/\s/g,""),"base64").toString("utf8");
}
// A branch name can survive a forced push or a replaced repository.
export function hasApprovedUpdateHead(pr,{repositoryId,headCommitSha}){
  return pr?.head?.sha===headCommitSha && pr?.head?.repo?.id===repositoryId &&
    pr.base?.repo?.id===repositoryId;
}

async function verifyUpdateCommit(gh,root,sha,baseSha,html){
  if(typeof sha!=="string"||!SHA.test(sha)||sha===baseSha)
    throw Error("GitHub did not report a verifiable website update commit");
  const commit=await gh(root+"/commits/"+sha);
  const files=commit?.files;
  if(commit?.sha!==sha||!Array.isArray(commit.parents)||commit.parents.length!==1||
     commit.parents[0]?.sha!==baseSha||!Array.isArray(files)||files.length!==1||
     files[0]?.filename!==HOMEPAGE||files[0].status!=="modified"||
     files[0].sha!==await gitBlobSha(html))
    throw Error("Update branch has unrelated changes or differs from the approved homepage");
}

export async function proposeWebsiteUpdate(input,{githubToken,fetchFn}={}){
  // Client code must never call this from a preview GET or AI-model output.
  if(input?.explicitlyApproved!==true)
    throw Error("Human approval is required before staging a website update");
  if(!SHA.test(input.expectedBaseCommitSha||"")||!DIGEST.test(input.approvedHtmlSha256||""))
    throw Error("Approved website preview and exact base GitHub revision are required");
  const {plan,html}=details(input);
  const htmlSha256=await digest(html);
  if(htmlSha256!==input.approvedHtmlSha256.toLowerCase())
    throw Error("Proposed HTML no longer matches the exact customer-approved preview");
  const gh=githubClient({token:githubToken,fetchFn});
  const owner=plan.githubOwner,repoName="esp-"+plan.customer;
  const root="/repos/"+encode(owner)+"/"+encode(repoName);
  const user=await gh("/user");
  if(user?.login?.toLowerCase()!==owner.toLowerCase()||!Number.isSafeInteger(user.id))
    throw Error("GitHub identity must match the authorized personal repository owner");
  const repo=await gh(root);
  if(input.expectedRepositoryId!==undefined &&
      (!Number.isSafeInteger(input.expectedRepositoryId)||input.expectedRepositoryId<1||
       repo?.id!==input.expectedRepositoryId))
    throw Error("Approved GitHub repository identity changed since review");
  if(!Number.isSafeInteger(repo?.id)||repo.id<1||repo.name!==repoName||repo.owner?.login?.toLowerCase()!==owner.toLowerCase()||
    repo?.owner?.id!==user.id||repo.private!==true||repo.default_branch!=="main"||
    !isManagedRepositoryDescription(repo.description,plan.customer))
    throw Error("Existing repository is not an exact private Launch & Own managed resource");
  const branchHead=await gh(root+"/branches/main");
  const baseSha=branchHead?.commit?.sha;
  if(typeof baseSha!=="string"||!SHA.test(baseSha)||baseSha!==input.expectedBaseCommitSha.toLowerCase())
    throw Error("GitHub main changed since preview; review the latest website before approving");
  const filePath=root+"/contents/"+HOMEPAGE;
  const existing=await gh(filePath+"?ref="+baseSha);
  const originalHtml=fileContent(existing);
  if(originalHtml===html){
    return {status:"already-current",repository:"https://github.com/"+owner+"/"+repoName,
      htmlSha256,baseCommitSha:baseSha,changesProposed:false};
  }
  const updateBranch="launch-and-own/site-"+(await digest(baseSha+":"+htmlSha256)).slice(0,20);
  const updateBranchPath=root+"/branches/"+encode(updateBranch);
  const openBranch=await gh(updateBranchPath,{allow404:true});
  let headCommitSha=openBranch?.commit?.sha;
  if(openBranch&&(typeof headCommitSha!=="string"||!SHA.test(headCommitSha)))
    throw Error("Existing update branch could not be verified");
  if(!openBranch)
    await gh(root+"/git/refs",{method:"POST",body:{ref:"refs/heads/"+updateBranch,sha:baseSha}});
  if(!openBranch||headCommitSha===baseSha){
    const staged=await gh(filePath,{method:"PUT",body:{message:"Propose customer-approved website copy update",
      branch:updateBranch,sha:existing.sha,content:Buffer.from(html,"utf8").toString("base64")}});
    headCommitSha=staged?.commit?.sha;
  }
  // A retry may recover a commit after a lost response, but it cannot adopt
  // other files or a commit based on a revision the customer did not review.
  await verifyUpdateCommit(gh,root,headCommitSha,baseSha,html);
  const target={repositoryId:repo.id,headCommitSha};
  // A retry must reuse the same PR if it was already opened. A previously
  // closed PR cannot be silently reopened or replaced without fresh approval.
  const query="?head="+encode(owner+":"+updateBranch)+"&base=main&state=all&per_page=20";
  const previous=await gh(root+"/pulls"+query);
  if(!Array.isArray(previous))throw Error("GitHub did not return pull request status");
  if(previous.length>0){
    const match=previous.find(p=>p.head?.ref===updateBranch&&p.base?.ref==="main");
    if(!match||match.state!=="open"||!Number.isSafeInteger(match.number)||match.number<1||
      !hasApprovedUpdateHead(match,target)||match.base.sha!==baseSha||
      match.html_url!=="https://github.com/"+owner+"/"+repoName+"/pull/"+match.number)
      throw Error("A previous update PR requires review before another attempt");
    return {status:"awaiting-customer-merge",repository:"https://github.com/"+owner+"/"+repoName,
      pullRequest:match.html_url,number:match.number,branch:updateBranch,
      htmlSha256,baseCommitSha:baseSha,headCommitSha,changesProposed:true,reused:true};
  }
  const currentBranch=await gh(updateBranchPath);
  if(currentBranch?.commit?.sha!==headCommitSha)
    throw Error("The reviewed update branch moved before the pull request could be opened");
  const summary=[
    "This change proposes exactly the website HTML previously reviewed and approved by the owner.",
    "Approval preview SHA-256: "+htmlSha256,
    "Reviewed main commit: "+baseSha,
    "No contact forms, custom domains, credentials or Cloudflare resources are changed.",
    "Review the diff before merging. Publication requires a separate, explicit merge and exact deployment verification."
  ].join("\n\n").slice(0,bodyMax);
  const pull=await gh(root+"/pulls",{method:"POST",body:{
    title:"Update "+input.name+" website (Launch & Own)",
    head:updateBranch,base:"main",body:summary,draft:false
  }});
  if(!Number.isSafeInteger(pull?.number)||pull.number<1||pull.state!=="open"||
     !hasApprovedUpdateHead(pull,target)||pull.head.ref!==updateBranch||
     pull.base.ref!=="main"||pull.base.sha!==baseSha||
     pull.html_url!=="https://github.com/"+owner+"/"+repoName+"/pull/"+pull.number)
    throw Error("GitHub pull request could not be verified");
  return {status:"awaiting-customer-merge",repository:"https://github.com/"+owner+"/"+repoName,
    pullRequest:pull.html_url,number:pull.number,branch:updateBranch,
    htmlSha256,baseCommitSha:baseSha,headCommitSha,changesProposed:true,reused:false};
}
