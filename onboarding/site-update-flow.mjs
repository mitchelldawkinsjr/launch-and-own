// Customer-facing one-page maintenance workflow. Preview receipts are short-lived,
// encrypted, session-bound, and never authorize a direct production branch write.
import {normalizeSite} from '../site/render-site.mjs';
import {readFormService} from './form-service.mjs';
import {previewWebsiteUpdate,proposeWebsiteUpdate} from '../pipeline/propose-site-update.mjs';
import {readManagedSiteBase,readApprovedUpdatePr} from '../pipeline/site-update-read.mjs';
import {MergeRefused,mergeVerifiedPullRequest} from '../pipeline/merge-approved-pr.mjs';
import {verifyWebsite} from '../pipeline/verify-site.mjs';
import {getOwnedJob,isLaunchId,approvalSnapshot,hasCurrentOwnerSession} from './launch-jobs.mjs';
import {seal,unseal} from './crypto.mjs';
import {renderUpdateStatusBody} from './post-launch-toolkit.mjs';
import {readToolkitPreviewStatus} from './toolkit-preview.mjs';

export class PreviewBuildPolicyUnavailable extends Error {}

const SHA=/^[a-f0-9]{40}$/i, DIGEST=/^[a-f0-9]{64}$/i;
const REVIEW_LIFETIME=15*60,STATUS_LIFETIME=30*24*60*60;
const htmlPreviewHeaders={
  'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
  'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
  // Re-check the live authorization epoch immediately before *each* provider call.
  // Logging out or reselecting an account fences the rest of an in-flight PR attempt.
export function ownerFencedFetch(env,current,now) {
    return async(url,options={})=>{
      if(!await hasCurrentOwnerSession(env,current,now()))
        throw Error('Connected account authorization changed during update');
      return await fetch(url,{...options,signal:options.signal??AbortSignal.timeout(8000)});
    };
  }
// Used by every flow that pushes a branch: refuses each GitHub write unless the Pages project's preview builds are off.
export function previewBuildFencedFetch(env,current,job,cloudflareAccessToken,now) {
    const fetchFn=ownerFencedFetch(env,current,now);
    const repositoryName='esp-'+job.site_slug;
    const previewRequest={
      site:{
        githubUserId:job.github_user_id,githubOwner:job.github_login,
        repositoryId:job.repository_id,repositoryName,
        cloudflareAccountId:job.cloudflare_account_id,pagesProjectId:job.pages_project_id,
        pagesProjectName:repositoryName+'-site',branch:job.production_branch
      },
      principal:{
        githubUserId:current.github_user_id,githubLogin:current.github_login,
        cloudflareAccountId:current.cloudflare_account_id
      },
      cloudflareAccessToken,
      assertCurrentAuthorization:()=>hasCurrentOwnerSession(env,current,now()),
      fetchFn:(url,options)=>fetch(url,{...options,cache:'no-store'})
    };
    // A GitHub branch push can trigger a separate Pages preview. Recheck the
    // owner's project setting before each write, including a retry's writes.
    return async(url,options={})=>{
      if((options.method??'GET')!=='GET'){
        const preview=await readToolkitPreviewStatus(previewRequest);
        if(preview.state!=='disabled')throw new PreviewBuildPolicyUnavailable();
      }
      return await fetchFn(url,options);
    };
  }
export function createSiteUpdateRoutes({view,fail,button,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now}) {
  const fencedFetch=(env,current)=>ownerFencedFetch(env,current,now);
  const previewFencedFetch=(env,current,job,token)=>previewBuildFencedFetch(env,current,job,token,now);
  const account=input=>({name:input.customer_name,githubOwner:input.github_login,
    accountId:input.cloudflare_account_id,githubUserId:input.github_user_id,
    repositoryId:input.repository_id,forms:false});
  async function ownedSite(env,current,id) {
    if(!current?.cloudflare_account_id||!current.cloudflare_token_ct||!isLaunchId(id))return null;
    const job=await getOwnedJob(env,current,id,now());
    if(!job||job.status!=='live'||job.production_branch!=='main'||
       !Number.isSafeInteger(job.repository_id)||job.repository_id<1||
       !SHA.test(job.expected_commit_sha||''))return null;
    const stored=JSON.parse(job.plan_json);
    if(!stored?.site||stored.site.layout==='multi-page'||stored.forms!==false||
      stored.accountId!==current.cloudflare_account_id||
      stored.githubOwner?.toLowerCase()!==current.github_login.toLowerCase())return null;
    const snapshot=await approvalSnapshot(job,current.github_user_id);
    if(snapshot.digest!==job.approval_digest||snapshot.slug!==job.site_slug)
      throw Error('Website approval snapshot changed');
    return {job,site:normalizeSite({...stored.site,name:job.customer_name})};
  }
  // withForm reads the deployed form service (one D1 query); later steps reuse the sealed ticket's copy
  // so approval stays inside the Workers subrequest budget.
  async function requireOwned(env,current,id,{withForm=false}={}) {
    const item=await ownedSite(env,current,id);
    if(!item)return null;
    const grants=await assertHistoryAccess(env,current);
    return {...item,grants,contactForm:withForm?await readFormService(env,current,item.job.id):null};
  }
  function inputFor(job,site,contactForm=null) {
    return {name:job.customer_name,githubOwner:job.github_login,
      accountId:job.cloudflare_account_id,forms:false,site,...(contactForm?{contactForm}:{})};
  }
  function ticketAad(kind,current){
    return kind==='review'?'site-update-review:'+current.hash:'site-update-status';
  }
  async function encodeTicket(env,kind,current,payload) {
    return seal(env.TOKEN_ENCRYPTION_KEY,JSON.stringify({
      version:1,kind,createdAt:now(),expiresAt:now()+(kind==='review'?REVIEW_LIFETIME:STATUS_LIFETIME),
      githubUserId:current.github_user_id,cloudflareAccountId:current.cloudflare_account_id,
      authorizationEpoch:kind==='review'?current.authorization_epoch:null,...payload
    }),ticketAad(kind,current));
  }
  async function decodeTicket(env,kind,current,raw) {
    if(!current?.cloudflare_account_id||typeof raw!=='string'||raw.length<50||raw.length>4096||
       !/^[A-Za-z0-9_-]+$/.test(raw))throw Error('Update review is unavailable or expired');
    let value;
    try {value=JSON.parse(await unseal(env.TOKEN_ENCRYPTION_KEY,raw,ticketAad(kind,current)));}
    catch {throw Error('Update review is unavailable or expired');}
    const time=now(),lifetime=kind==='review'?REVIEW_LIFETIME:STATUS_LIFETIME;
    if(value?.kind!==kind||value.version!==1||!Number.isSafeInteger(value.createdAt)||
      value.createdAt>time||value.createdAt<time-lifetime||
      value.expiresAt!==value.createdAt+lifetime||value.expiresAt<=time||
      value.githubUserId!==current.github_user_id||
      value.cloudflareAccountId!==current.cloudflare_account_id||
      (kind==='review'&&value.authorizationEpoch!==current.authorization_epoch)||
      !isLaunchId(value.jobId)||!SHA.test(value.baseCommitSha||'')||
      !DIGEST.test(value.approvedHtmlSha256||'')||
      (value.headCommitSha!==undefined&&!SHA.test(value.headCommitSha)))
      throw Error('Update review is unavailable or expired');
    return value;
  }
  async function reviewData(env,current,raw) {
    const ticket=await decodeTicket(env,'review',current,raw);
    const item=await requireOwned(env,current,ticket.jobId);
    if(!item||ticket.repositoryId!==item.job.repository_id)
      throw Error('The website ownership or update approval has changed');
    const site=normalizeSite({...ticket.site,name:item.job.customer_name});
    item.contactForm=ticket.contactForm??null;
    const preview=await previewWebsiteUpdate(inputFor(item.job,site,item.contactForm));
    if(preview.htmlSha256!==ticket.approvedHtmlSha256)
      throw Error('The website content differs from the approved preview');
    return {item,site,ticket,preview};
  }
  async function editor(env,current,id) {
    const item=await requireOwned(env,current,id,{withForm:true});
    if(!item)return fail('Connect both accounts and open a live one-page website you own from your launches.',404);
    const s=item.site;
    const themes=['ocean','forest','sunset','graphite'];
    const fields=[
      '<input type="hidden" name="id" value="'+escape(id)+'">',
      '<label for="tagline">Homepage headline</label><input id="tagline" name="tagline" maxlength="140" value="'+escape(s.tagline)+'">',
      '<label for="about">About your business</label><textarea id="about" name="about" maxlength="650" rows="5">'+escape(s.about)+'</textarea>',
      '<label for="services">Services (one per line, up to six)</label><textarea id="services" name="services" rows="4">'+escape(s.services.join('\n'))+'</textarea>',
      '<label for="theme">Theme</label><select id="theme" name="theme">'+themes.map(x=>'<option value="'+x+'"'+(x===s.theme?' selected':'')+'>'+escape(x)+'</option>').join('')+'</select>',
      '<label for="contactEmail">Contact email (optional)</label><input id="contactEmail" type="email" name="contactEmail" maxlength="254" value="'+escape(s.contactEmail)+'">'
    ].join('');
    const formNote=item.contactForm?'<p role="status">Your form service is set up, so this update adds a contact form to the Contact section. Preview it before you approve.</p>':'';
    return view('Edit '+s.name,formNote+'<p>You are editing from the copy that was approved at launch. If you changed files on GitHub since then, read the preview carefully. Saving here never publishes straight to the live site.</p>'+
      '<p><strong>Private files folder:</strong> '+escape('esp-'+item.job.site_slug)+'</p>'+
      button('/site-update-preview','Preview website changes',current.csrf,fields)+
      '<p><a href="/history">Back to your launches</a></p>');
  }
  async function prepare(request,env,current) {
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    const item=await requireOwned(env,current,form.get('id'),{withForm:true});
    if(!item)return fail('This live website is not available for editing.',404);
    const site=normalizeSite({name:item.job.customer_name,tagline:form.get('tagline')||'',
      about:form.get('about')||'',services:form.get('services')||'',
      theme:form.get('theme')||'ocean',contactEmail:form.get('contactEmail')||''});
    const fetchFn=fencedFetch(env,current);
    const base=await readManagedSiteBase(account(item.job),{githubToken:item.grants.githubAccessToken,fetchFn});
    const preview=await previewWebsiteUpdate(inputFor(item.job,site,item.contactForm));
    const ticket=await encodeTicket(env,'review',current,{jobId:item.job.id,
      repositoryId:item.job.repository_id,baseCommitSha:base.baseCommitSha,
      approvedHtmlSha256:preview.htmlSha256,site,...(item.contactForm?{contactForm:{workerUrl:item.contactForm.workerUrl,sitekey:item.contactForm.sitekey}}:{})});
    return new Response(null,{status:303,headers:{
      location:'/site-update-review?ticket='+encodeURIComponent(ticket),'cache-control':'no-store','referrer-policy':'same-origin'
    }});
  }
  async function review(env,current,raw) {
    let data;
    try{data=await reviewData(env,current,raw);}
    catch{return fail('This site update preview expired or your account changed. Start a fresh edit.',400);}
    const {item,ticket}=data;
    return view('Review your update',
      '<p><strong>Site:</strong> '+escape(item.job.customer_name)+'</p>'+
      '<p><a href="/site-update-html?ticket='+encodeURIComponent(raw)+'" target="_blank" rel="noopener"><strong>See exactly how it will look</strong></a></p>'+
      '<p><strong>Approve and publish</strong> confirms automatic Cloudflare Pages preview builds are off, commits exactly this page to your website\'s <code>main</code> branch and merges it. Cloudflare Pages publishes it, and Launch &amp; Own checks the public site. If your site changed since this preview, nothing is published. Prefer to review it in GitHub first? Choose <strong>Open a pull request instead</strong> and merge it yourself.</p>'+
      '<details><summary>Technical details</summary><p>Starting version: <code>'+escape(ticket.baseCommitSha)+
      '</code></p><p>Exact preview code: <code>'+escape(ticket.approvedHtmlSha256)+'</code></p></details>'+
      // Owner decision 2026-11-26: approving publishes; a pull request stays available.
      '<form action="/site-update-approve" method="POST"><input type="hidden" name="csrf" value="'+escape(current.csrf)+'">'+
        '<input type="hidden" name="ticket" value="'+escape(raw)+'">'+
        '<button type="submit" name="action" value="publish">Approve and publish</button> '+
        '<button type="submit" name="action" value="pr" class="btn-secondary">Open a pull request instead</button></form>'+
      '<p><a href="/site-update?id='+encodeURIComponent(item.job.id)+'">Edit again</a></p>');
  }
  async function html(env,current,raw) {
    let data;
    try{data=await reviewData(env,current,raw);}
    catch{return fail('This exact website preview is unavailable.',404);}
    return new Response(data.preview.html,{status:200,headers:htmlPreviewHeaders});
  }
  async function approve(request,env,current) {
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    const {item,site,ticket}=await reviewData(env,current,form.get('ticket'));
    const fetchFn=previewFencedFetch(env,current,item.job,item.grants.cloudflareAccessToken);
    let proposal;
    try{
      proposal=await proposeWebsiteUpdate({...inputFor(item.job,site,item.contactForm),explicitlyApproved:true,
        approvedHtmlSha256:ticket.approvedHtmlSha256,expectedBaseCommitSha:ticket.baseCommitSha,
        expectedRepositoryId:item.job.repository_id},{githubToken:item.grants.githubAccessToken,fetchFn});
    }catch(error){
      if(error instanceof PreviewBuildPolicyUnavailable)
        return fail('The update paused before the next GitHub change. Confirm automatic preview builds are disabled in the linked Cloudflare Pages project, then review and approve again.',409);
      return fail('GitHub could not prepare the approved PR. Confirm the GitHub App has Pull requests: write permission and try a fresh preview. No merge or publication was performed.',409);
    }
    if(proposal.status==='already-current')return view('No changes needed',
      '<p>The page you approved already matches what is in your private files. No change request was created. Check your live site or edit again.</p>'+
      '<p><a href="/history">Back to your launches</a></p>');
    // "Approve and publish": merge exactly this PR after re-verifying it; any refusal leaves it open.
    let mergeNote=null;
    if(form.get('action')!=='pr'){
      try{
        const pr=await readApprovedUpdatePr({...account(item.job),baseCommitSha:ticket.baseCommitSha,approvedHtmlSha256:ticket.approvedHtmlSha256,
          number:proposal.number,headCommitSha:proposal.headCommitSha},{githubToken:item.grants.githubAccessToken,fetchFn});
        if(pr.status!=='awaiting-customer-merge')throw new MergeRefused('merge_blocked');
        await mergeVerifiedPullRequest({owner:item.job.github_login,repoName:'esp-'+item.job.site_slug,number:proposal.number,
          headCommitSha:proposal.headCommitSha,baseCommitSha:ticket.baseCommitSha},{githubToken:item.grants.githubAccessToken,fetchFn});
      }catch(error){
        if(!(error instanceof MergeRefused))throw error;
        mergeNote=error.code;
      }
    }
    const receipt=await encodeTicket(env,'status',current,{mergeNote,jobId:item.job.id,repositoryId:item.job.repository_id,
      baseCommitSha:ticket.baseCommitSha,approvedHtmlSha256:ticket.approvedHtmlSha256,
      number:proposal.number,headCommitSha:proposal.headCommitSha});
    return new Response(null,{status:303,headers:{
      location:'/site-update-status?ticket='+encodeURIComponent(receipt),'cache-control':'no-store','referrer-policy':'same-origin'
    }});
  }
  async function status(env,current,raw) {
    let receipt;
    try{receipt=await decodeTicket(env,'status',current,raw);}
    catch{return fail('This update receipt expired. Reconnect and reopen your owned website.',404);}
    if(!Number.isSafeInteger(receipt.number)||receipt.number<1)return fail('This update receipt is invalid.',400);
    const item=await requireOwned(env,current,receipt.jobId);
    if(!item||item.job.repository_id!==receipt.repositoryId)
      return fail('This update does not belong to your connected accounts.',404);
    const fetchFn=fencedFetch(env,current);
    const {githubAccessToken:githubToken,cloudflareAccessToken:cloudflareToken}=item.grants;
    const pr=await readApprovedUpdatePr({...account(item.job),...receipt},{githubToken,fetchFn});
    let result;
    if(pr.status==='merged'){
      result=await verifyWebsite(inputFor(item.job,item.site),{cloudflareToken,fetchFn,
        expectedProject:{projectId:item.job.pages_project_id,repositoryId:item.job.repository_id,
          githubUserId:item.job.github_user_id,branch:item.job.production_branch},
        expectedCommitSha:pr.mergedCommitSha,expectedHtmlSha256:receipt.approvedHtmlSha256});
    }
    if(!await hasCurrentOwnerSession(env,current,now()))
      return fail('Your connected accounts changed. Reconnect to check this update.',401);
    const blocked=pr.status==='awaiting-customer-merge'&&receipt.mergeNote
      ?'<p>'+(receipt.mergeNote==='stale_base'?'Your website changed after you approved, so it was not published automatically.'
        :'GitHub did not allow an automatic merge, so it was not published.')+' Merge the pull request yourself when you are ready.</p>':'';
    return view('Website change status',
      '<p><strong>Site:</strong> '+escape(item.job.customer_name)+'</p>'+blocked+
      renderUpdateStatusBody({
        pr, verifyResult: result, approvedHtmlSha256: receipt.approvedHtmlSha256,
        ticketRaw: raw, jobId: item.job.id, escape
      }));
  }
  return {editor,prepare,review,html,approve,status};
}
