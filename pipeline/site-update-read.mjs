// Read-only, tenant-bound GitHub state for self-service website maintenance.
// Provider credentials never leave the Worker or appear in responses.
import {planCustomer} from './plan-customer.mjs';
import {isManagedRepositoryDescription} from './managed-site-repository.mjs';
import {sha256} from '../onboarding/crypto.mjs';

const SHA=/^[a-f0-9]{40}$/i, DIGEST=/^[a-f0-9]{64}$/i;
const encode=encodeURIComponent;
function validate(input) {
  if(input?.forms||input?.hostname)throw Error('Only managed static pages.dev websites can be updated');
  const plan=planCustomer(input);
  if(!Number.isSafeInteger(input.githubUserId)||input.githubUserId<1)throw Error('Verified GitHub identity is required');
  return {plan,owner:plan.githubOwner,repoName:'esp-'+plan.customer};
}
function client(token,fetchFn=fetch) {
  if(typeof token!=='string'||!token)throw Error('A connected GitHub account is required');
  return async(path)=>{
    const response=await fetchFn('https://api.github.com'+path,{method:'GET',redirect:'manual',
      headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json',
        'x-github-api-version':'2022-11-28','user-agent':'launch-and-own'}});
    if(!response.ok)throw Error('GitHub could not verify the managed website or proposed update (HTTP '+response.status+')');
    const json=await response.json();
    if(!json||typeof json!=='object')throw Error('Unexpected GitHub website response');
    return json;
  };
}
async function readManaged(input,options={}) {
  const {owner,repoName,plan}=validate(input),gh=client(options.githubToken,options.fetchFn);
  const root='/repos/'+encode(owner)+'/'+encode(repoName);
  const user=await gh('/user');
  if(user?.id!==input.githubUserId||user?.login?.toLowerCase()!==owner.toLowerCase())
    throw Error('Authenticated GitHub identity does not own this site');
  const repo=await gh(root);
  if(repo?.id!==input.repositoryId||repo?.name!==repoName||repo?.private!==true||
     repo?.default_branch!=='main'||repo?.owner?.id!==input.githubUserId||
     repo?.owner?.login?.toLowerCase()!==owner.toLowerCase()||
     !isManagedRepositoryDescription(repo.description,plan.customer))
    throw Error('GitHub repository is not the approved private managed site');
  return {root,gh,owner,repoName};
}
export async function readManagedSiteBase(input,options={}) {
  const {root,gh,owner,repoName}=await readManaged(input,options);
  const branch=await gh(root+'/branches/main');
  const sha=branch?.commit?.sha;
  if(typeof sha!=='string'||!SHA.test(sha))throw Error('Current GitHub main revision could not be verified');
  return {baseCommitSha:sha.toLowerCase(),repository:'https://github.com/'+owner+'/'+repoName};
}
export async function readApprovedUpdatePr(input,options={}) {
  if(!Number.isSafeInteger(input.number)||input.number<1||!SHA.test(input.baseCommitSha||'')||
      !DIGEST.test(input.approvedHtmlSha256||''))throw Error('Invalid approved website update receipt');
  const {root,gh,owner,repoName}=await readManaged(input,options);
  const branch='launch-and-own/site-'+(await sha256(input.baseCommitSha.toLowerCase()+':'+input.approvedHtmlSha256.toLowerCase())).slice(0,20);
  const pr=await gh(root+'/pulls/'+input.number);
  const url='https://github.com/'+owner+'/'+repoName+'/pull/'+input.number;
  if(pr?.number!==input.number||pr?.html_url!==url||pr?.base?.ref!=='main'||
      pr?.head?.ref!==branch||pr?.head?.repo?.full_name&&pr.head.repo.full_name.toLowerCase()!==(owner+'/'+repoName).toLowerCase())
    throw Error('Pull request does not match the exact approved website update');
  if(pr.merged_at||pr.merged===true){
    if(typeof pr.merge_commit_sha!=='string'||!SHA.test(pr.merge_commit_sha))
      throw Error('Merged pull request commit cannot be verified');
    return {status:'merged',pullRequest:url,mergedCommitSha:pr.merge_commit_sha.toLowerCase()};
  }
  if(pr.state==='closed')return {status:'closed-unmerged',pullRequest:url};
  if(pr.state!=='open')throw Error('Unknown pull request state');
  return {status:'awaiting-customer-merge',pullRequest:url};
}
