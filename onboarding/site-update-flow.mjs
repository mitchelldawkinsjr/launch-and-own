// Customer-facing one-page maintenance workflow. Preview receipts are short-lived,
// encrypted, session-bound, and never authorize a direct production branch write.
import {normalizeSite} from '../site/render-site.mjs';
import {previewWebsiteUpdate,proposeWebsiteUpdate} from '../pipeline/propose-site-update.mjs';
import {readManagedSiteBase,readApprovedUpdatePr} from '../pipeline/site-update-read.mjs';
import {verifyWebsite} from '../pipeline/verify-site.mjs';
import {getOwnedJob,isLaunchId,approvalSnapshot} from './launch-jobs.mjs';
import {getFreshAccessToken} from './token-lifecycle.mjs';
import {seal,unseal} from './crypto.mjs';

const SHA=/^[a-f0-9]{40}$/i, DIGEST=/^[a-f0-9]{64}$/i;
const REVIEW_LIFETIME=15*60,STATUS_LIFETIME=30*24*60*60;
const htmlPreviewHeaders={
  'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
  'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
export function createSiteUpdateRoutes({view,fail,button,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now}) {
  // Re-check the live authorization epoch immediately before *each* provider call.
  // Logging out or reselecting an account fences the rest of an in-flight PR attempt.
  function fencedFetch(env,current) {
    return async(url,options={})=>{
      const active=await env.DB.prepare(`SELECT 1 FROM onboarding_sessions
        WHERE id_hash=? AND authorization_epoch=? AND github_user_id=?
          AND cloudflare_account_id=? AND github_token_ct IS NOT NULL
          AND cloudflare_token_ct IS NOT NULL AND expires_at>?`)
        .bind(current.hash,current.authorization_epoch,current.github_user_id,
          current.cloudflare_account_id,now()).first();
      if(!active)throw Error('Connected account authorization changed during update');
      return await fetch(url,{...options,signal:options.signal??AbortSignal.timeout(8000)});
    };
  }
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
  async function requireOwned(env,current,id) {
    const item=await ownedSite(env,current,id);
    if(!item)return null;
    await assertHistoryAccess(env,current);
    return item;
  }
  function inputFor(job,site) {
    return {name:job.customer_name,githubOwner:job.github_login,
      accountId:job.cloudflare_account_id,forms:false,site};
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
      !DIGEST.test(value.approvedHtmlSha256||''))
      throw Error('Update review is unavailable or expired');
    return value;
  }
  async function reviewData(env,current,raw) {
    const ticket=await decodeTicket(env,'review',current,raw);
    const item=await requireOwned(env,current,ticket.jobId);
    if(!item||ticket.repositoryId!==item.job.repository_id)
      throw Error('The website ownership or update approval has changed');
    const site=normalizeSite({...ticket.site,name:item.job.customer_name});
    const preview=await previewWebsiteUpdate(inputFor(item.job,site));
    if(preview.htmlSha256!==ticket.approvedHtmlSha256)
      throw Error('The website content differs from the approved preview');
    return {item,site,ticket,preview};
  }
  async function editor(env,current,id) {
    const item=await requireOwned(env,current,id);
    if(!item)return fail('Connect both accounts and open an owned, verified live one-page website from launch history.',404);
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
    return view('Edit '+s.name,'<p>Starting from your original approved website copy. If you have edited GitHub since launch, review your changes carefully. This editor never writes directly to your live website.</p>'+
      '<p><strong>Private repository:</strong> '+escape('esp-'+item.job.site_slug)+'</p>'+
      button('/site-update-preview','Preview website changes',current.csrf,fields)+
      '<p><a href="/history">Back to launch history</a></p>');
  }
  async function prepare(request,env,current) {
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    const item=await requireOwned(env,current,form.get('id'));
    if(!item)return fail('This live website is not available for editing.',404);
    const site=normalizeSite({name:item.job.customer_name,tagline:form.get('tagline')||'',
      about:form.get('about')||'',services:form.get('services')||'',
      theme:form.get('theme')||'ocean',contactEmail:form.get('contactEmail')||''});
    const fetchFn=fencedFetch(env,current);
    const githubToken=await getFreshAccessToken({env,session:current,provider:'github',fetchFn});
    const base=await readManagedSiteBase(account(item.job),{githubToken,fetchFn});
    const preview=await previewWebsiteUpdate(inputFor(item.job,site));
    const ticket=await encodeTicket(env,'review',current,{jobId:item.job.id,
      repositoryId:item.job.repository_id,baseCommitSha:base.baseCommitSha,
      approvedHtmlSha256:preview.htmlSha256,site});
    return new Response(null,{status:303,headers:{
      location:'/site-update-review?ticket='+encodeURIComponent(ticket),'cache-control':'no-store','referrer-policy':'same-origin'
    }});
  }
  async function review(env,current,raw) {
    let data;
    try{data=await reviewData(env,current,raw);}
    catch{return fail('This site update preview expired or your account changed. Start a fresh edit.',400);}
    const {item,ticket}=data;
    return view('Review the website update',
      '<p><strong>Site:</strong> '+escape(item.job.customer_name)+'</p>'+
      '<p><strong>Private GitHub repository:</strong> '+escape('esp-'+item.job.site_slug)+'</p>'+
      '<p><strong>Reviewed main commit:</strong> <code>'+escape(ticket.baseCommitSha)+'</code></p>'+
      '<p><strong>Exact preview SHA-256:</strong> <code>'+escape(ticket.approvedHtmlSha256)+'</code></p>'+
      '<p><a href="/site-update-html?ticket='+encodeURIComponent(raw)+'" target="_blank" rel="noopener">Open exact website preview</a></p>'+
      '<p>Approval creates only a GitHub feature branch and a reviewable pull request. Your site stays unchanged until <strong>you manually merge</strong> the PR and Cloudflare finishes publishing. GitHub must authorize the app to create pull requests.</p>'+
      button('/site-update-approve','Approve and create reviewable PR',current.csrf,
        '<input type="hidden" name="ticket" value="'+escape(raw)+'">')+
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
    const fetchFn=fencedFetch(env,current);
    const githubToken=await getFreshAccessToken({env,session:current,provider:'github',fetchFn});
    let proposal;
    try{
      proposal=await proposeWebsiteUpdate({...inputFor(item.job,site),explicitlyApproved:true,
        approvedHtmlSha256:ticket.approvedHtmlSha256,expectedBaseCommitSha:ticket.baseCommitSha},{githubToken,fetchFn});
    }catch {
      return fail('GitHub could not prepare the approved PR. Confirm the GitHub App has Pull requests: write permission and try a fresh preview. No merge or publication was performed.',409);
    }
    if(proposal.status==='already-current')return view('No changes needed',
      '<p>The approved HTML already matches GitHub main. No branch or PR was created. Check your website or edit again.</p>'+
      '<p><a href="/history">Back to launch history</a></p>');
    const receipt=await encodeTicket(env,'status',current,{jobId:item.job.id,repositoryId:item.job.repository_id,
      baseCommitSha:ticket.baseCommitSha,approvedHtmlSha256:ticket.approvedHtmlSha256,number:proposal.number});
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
    const githubToken=await getFreshAccessToken({env,session:current,provider:'github',fetchFn});
    const pr=await readApprovedUpdatePr({...account(item.job),...receipt},{githubToken,fetchFn});
    let result;
    if(pr.status==='merged'){
      const cloudflareToken=await getFreshAccessToken({env,session:current,provider:'cloudflare',fetchFn});
      result=await verifyWebsite(inputFor(item.job,item.site),{cloudflareToken,fetchFn,
        expectedCommitSha:pr.mergedCommitSha,expectedHtmlSha256:receipt.approvedHtmlSha256});
    }
    const refresh='<p><a href="/site-update-status?ticket='+encodeURIComponent(raw)+'">Check deployment status again</a></p>';
    const merged=pr.status==='merged'?
      '<p>GitHub merged revision: <code>'+escape(pr.mergedCommitSha)+'</code></p><p>Cloudflare verification: <strong>'+escape(result.status)+'</strong></p>'+
      (result.status==='live'?'<p class="pill">Verified live: exact merged commit and approved HTML SHA-256 match</p><p><a href="'+escape(result.website)+'">'+escape(result.website)+'</a></p>':
        '<p>Do not consider this update published yet. Cloudflare may still be building or showing an older revision.</p>'):
      '<p>The pull request is '+escape(pr.status)+'. Your live site has not been verified against this change.</p>';
    return view('Website update status',
      '<p>Customer-controlled GitHub PR: <a href="'+escape(pr.pullRequest)+'" rel="noopener">'+escape(pr.pullRequest)+'</a></p>'+
      '<p>Approved HTML SHA-256: <code>'+escape(receipt.approvedHtmlSha256)+'</code></p>'+merged+refresh+
      '<p>This receipt lasts 30 days and is accessible only with the same verified GitHub identity and Cloudflare account.</p><p><a href="/history">Back to launch history</a></p>');
  }
  return {editor,prepare,review,html,approve,status};
}
