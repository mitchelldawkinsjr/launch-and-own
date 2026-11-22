import {beginGitHubAppOAuth,completeGitHubAppOAuth} from '../pipeline/github-app-oauth.mjs';
import {beginCloudflareOAuth,completeCloudflareOAuth,verifyCloudflareAccount} from '../pipeline/cloudflare-oauth.mjs';
import {verifyProviderConnections} from '../pipeline/authorization-checks.mjs';
import {planCustomer} from '../pipeline/plan-customer.mjs';
import {normalizeSite,renderSite} from '../site/render-site.mjs';
import {draftSiteFromBrief,aiDraftConfigured} from '../site/draft-site.mjs';
import {randomToken,sha256,seal,unseal} from './crypto.mjs';
import {revokeConnectedAccounts} from './revoke-connections.mjs';
import {encryptGrant,getFreshAccessToken} from './token-lifecycle.mjs';
import {listOwnedReceipts,getOwnedReceipt,purgeExpiredReceipts} from './launch-receipts.mjs';
import {privacyHtml,termsHtml} from './legal-pages.mjs';
import {LOGO_PNG_BASE64} from './logo.mjs';
import {approvalSnapshot,approveJob,deleteOwnedLaunch,getOwnedJob,isLaunchId,listOwnedJobs} from './launch-jobs.mjs';
import {launchSchemaReady} from './launch-schema.mjs';
import {runLaunchJob,runScheduledLaunches} from './run-launch-jobs.mjs';

const COOKIE_SESSION='__Host-esp_session';
const COOKIE_LOGIN='__Host-esp_login';
const textHeaders={
  'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'x-frame-options':'DENY','x-content-type-options':'nosniff',
  // same-origin, not no-referrer: under no-referrer Chrome sends `Origin: null` on form POSTs, failing assertCsrf.
  'referrer-policy':'same-origin',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const now=()=>Math.floor(Date.now()/1000);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookie=(name,value,maxAge)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const redirect=(path,setCookie)=>{
  const headers=new Headers({'location':path,'cache-control':'no-store','referrer-policy':'same-origin'});
  if(setCookie)headers.append('set-cookie',setCookie);
  return new Response(null,{status:303,headers});
};
const view=(title,body,status=200)=>new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Launch & Own</title><style>
body{font:16px/1.6 system-ui,sans-serif;background:#f6f8fc;color:#15243a;margin:0}main{max-width:680px;margin:5vh auto;padding:32px;background:white;border:1px solid #dfe6ef;border-radius:18px}h1{font-size:30px;margin:0 0 18px}a,button{color:#174ca5}button{padding:10px 16px;background:#174ca5;color:white;border:0;border-radius:8px;cursor:pointer}input,select,textarea{padding:10px;width:100%;box-sizing:border-box;margin-bottom:16px;border:1px solid #a1acba;border-radius:6px}textarea{resize:vertical}label{display:block;font-weight:600}small{color:#455771}.muted{color:#65738a}.pill{display:inline-block;padding:2px 8px;background:#e8f1e9;border-radius:12px}p{overflow-wrap:anywhere}section{border-top:1px solid #e5eaf0;padding-top:14px;margin-top:18px}footer{margin-top:28px;font-size:13px;color:#53657a}</style></head><body><main><h1>${escape(title)}</h1>${body}<footer>Customer-controlled hosting · No paid email service · Beta onboarding · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer></main></body></html>`,{status,headers:textHeaders});
const fail=(message,status=400)=>view('Setup could not continue',`<p>${escape(message)}</p><p><a href="/">Return to setup</a></p>`,status);
const button=(action,label,csrf,extra='')=>`<form action="${action}" method="POST"><input type="hidden" name="csrf" value="${escape(csrf)}">${extra}<button type="submit">${escape(label)}</button></form>`;
function cookies(request){
  const output={};for(const part of (request.headers.get('cookie')||'').split(';')){
    const cut=part.indexOf('=');if(cut>0)output[part.slice(0,cut).trim()]=part.slice(cut+1).trim();
  }return output;
}
function baseUrl(env){
  const origin=env.ONBOARDING_ORIGIN;
  if(typeof origin!=='string')throw Error('Onboarding origin is not configured');
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/' || url.origin!==origin)
    throw Error('Onboarding origin must be an exact HTTPS origin');
  return origin;
}
function configured(env){
  baseUrl(env);
  for(const key of ['DB','TOKEN_ENCRYPTION_KEY','GH_CLIENT_ID','GH_CLIENT_SECRET','CF_CLIENT_ID','CF_CLIENT_SECRET','CF_SCOPES','ONBOARDING_LIMITER']){
    if(!env[key])throw Error('Onboarding account connections are not configured');
  }
  if(!/^[a-f\d]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY))throw Error('Invalid token encryption key');
}
async function session(request,env){
  const raw=cookies(request)[COOKIE_SESSION];
  if(!raw||!/^[a-f\d]{64}$/.test(raw))return null;
  const hash=await sha256(raw);
  const record=await env.DB.prepare(`SELECT id_hash, github_user_id, github_login, github_token_ct,
    github_refresh_token_ct, github_token_expires_at, github_refresh_expires_at, cloudflare_token_ct,
    cloudflare_refresh_token_ct, cloudflare_token_expires_at, cloudflare_refresh_expires_at,
    cloudflare_account_id, csrf_ct, expires_at, authorization_epoch FROM onboarding_sessions
    WHERE id_hash=? AND expires_at>?`).bind(hash,now()).first();
  if(!record)return null;
  const csrf=await unseal(env.TOKEN_ENCRYPTION_KEY,record.csrf_ct,'csrf:'+hash);
  return {...record,hash,csrf};
}
function assertCsrf(request,form,current,origin){
  if(!current)throw Error('Please connect GitHub again');
  if(request.headers.get('origin')!==origin)throw Error('Form origin could not be verified');
  if(form.getAll('csrf').length!==1 || form.get('csrf')!==current.csrf)throw Error('This form expired. Please reload the page');
}
async function formData(request){
  if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type')||''))throw Error('Unsupported form submission');
  const len=Number(request.headers.get('content-length')||0);
  if(len>4096)throw Error('Form submission is too large');
  const raw=await request.text();
  if(raw.length>4096)throw Error('Form submission is too large');
  return new URLSearchParams(raw);
}
async function saveFlow(env,{provider,binding,state,codeVerifier}){
  const key=await sha256(state);
  const bindingHash=await sha256(binding);
  const ciphertext=await seal(env.TOKEN_ENCRYPTION_KEY,codeVerifier,'flow:'+key);
  await env.DB.prepare('INSERT INTO onboarding_flows(state_hash,provider,binding_hash,verifier_ct,expires_at) VALUES(?,?,?,?,?)')
    .bind(key,provider,bindingHash,ciphertext,now()+600).run();
}
async function consumeFlow(env,{provider,binding,state}){
  if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state)||!binding)throw Error('Missing or expired authorization');
  const key=await sha256(state);
  const bindingHash=await sha256(binding);
  // Single atomic update: another callback cannot reuse the same authorization attempt.
  const row=await env.DB.prepare('UPDATE onboarding_flows SET consumed_at=? WHERE state_hash=? AND provider=? AND binding_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING verifier_ct')
    .bind(now(),key,provider,bindingHash,now()).first();
  if(!row)throw Error('Authorization expired or already used');
  return await unseal(env.TOKEN_ENCRYPTION_KEY,row.verifier_ct,'flow:'+key);
}
async function apiGet(url,token){
  const resp=await fetch(url,{headers:{'authorization':'Bearer '+token,'accept':'application/json','x-github-api-version':'2022-11-28','user-agent':'launch-and-own'},redirect:'manual'});
  if(!resp.ok)throw Error('Provider identity verification failed');
  return await resp.json();
}
async function limitAttempts(request,env){
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const r=await env.ONBOARDING_LIMITER.limit({key:ip});
  if(!r.success)throw Error('Rate limit reached');
}
async function gitHubStart(request,env){
  await limitAttempts(request,env);
  const origin=baseUrl(env),nonce=randomToken();
  const {authorizationUrl,session:flow}=beginGitHubAppOAuth({clientId:env.GH_CLIENT_ID,redirectUri:origin+'/oauth/github/callback'});
  await saveFlow(env,{provider:'github',binding:nonce,...flow});
  return redirect(authorizationUrl,cookie(COOKIE_LOGIN,nonce,600));
}
async function gitHubCallback(request,env,current){
  const url=new URL(request.url);
  if(url.searchParams.has('error'))return fail('GitHub authorization was cancelled. You can try again.');
  const nonce=cookies(request)[COOKIE_LOGIN];
  const verifier=await consumeFlow(env,{provider:'github',binding:nonce,state:url.searchParams.get('state')});
  const token=await completeGitHubAppOAuth({clientId:env.GH_CLIENT_ID,clientSecret:env.GH_CLIENT_SECRET,redirectUri:baseUrl(env)+'/oauth/github/callback',code:url.searchParams.get('code'),receivedState:url.searchParams.get('state'),expectedState:url.searchParams.get('state'),codeVerifier:verifier});
  const user=await apiGet('https://api.github.com/user',token.access_token);
  if(typeof user.login!=='string'||!Number.isSafeInteger(user.id)||user.id<1)throw Error('Unable to verify the connected GitHub user');
  const raw=randomToken(),hash=await sha256(raw),csrf=randomToken();
  const ghGrant=await encryptGrant({grant:token,provider:'github',sessionHash:hash,encryptionKey:env.TOKEN_ENCRYPTION_KEY});
  const csrfCipher=await seal(env.TOKEN_ENCRYPTION_KEY,csrf,'csrf:'+hash);
  const createSession=env.DB.prepare('INSERT INTO onboarding_sessions(id_hash,github_user_id,github_login,github_token_ct,github_refresh_token_ct,github_token_expires_at,github_refresh_expires_at,csrf_ct,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(hash,user.id,user.login,ghGrant.accessCipher,ghGrant.refreshCipher,ghGrant.accessExpiresAt,ghGrant.refreshExpiresAt,csrfCipher,now(),now()+3600);
  if(current){
    await env.DB.batch([createSession,env.DB.prepare('DELETE FROM onboarding_sessions WHERE id_hash=?').bind(current.hash)]);
  }else await createSession.run();
  const response=redirect('/');
  response.headers.append('set-cookie',cookie(COOKIE_SESSION,raw,3600));
  response.headers.append('set-cookie',cookie(COOKIE_LOGIN,'',0));
  return response;
}
async function cloudflareStart(request,env,current){
  await limitAttempts(request,env);
  if(!current)return fail('Connect GitHub before connecting Cloudflare.',401);
  const origin=baseUrl(env),scopes=String(env.CF_SCOPES).trim().split(/\s+/);
  const {authorizationUrl,session:flow}=beginCloudflareOAuth({clientId:env.CF_CLIENT_ID,redirectUri:origin+'/oauth/cloudflare/callback',scopes});
  await saveFlow(env,{provider:'cloudflare',binding:current.hash,...flow});
  return redirect(authorizationUrl);
}
async function cloudflareCallback(request,env,current){
  if(!current)return fail('Your session expired. Connect GitHub again.',401);
  const url=new URL(request.url);
  if(url.searchParams.has('error'))return fail('Cloudflare authorization was cancelled. You can try again.');
  const verifier=await consumeFlow(env,{provider:'cloudflare',binding:current.hash,state:url.searchParams.get('state')});
  const token=await completeCloudflareOAuth({clientId:env.CF_CLIENT_ID,clientSecret:env.CF_CLIENT_SECRET,redirectUri:baseUrl(env)+'/oauth/cloudflare/callback',code:url.searchParams.get('code'),receivedState:url.searchParams.get('state'),expectedState:url.searchParams.get('state'),codeVerifier:verifier});
  const encrypted=await encryptGrant({grant:token,provider:'cloudflare',sessionHash:current.hash,encryptionKey:env.TOKEN_ENCRYPTION_KEY});
  const updated=await env.DB.prepare(`UPDATE onboarding_sessions SET cloudflare_token_ct=?, cloudflare_refresh_token_ct=?,
    cloudflare_token_expires_at=?, cloudflare_refresh_expires_at=?, cloudflare_refresh_locked_until=NULL,
    cloudflare_account_id=NULL, authorization_epoch=authorization_epoch+1
    WHERE id_hash=? AND authorization_epoch=? AND expires_at>? RETURNING id_hash`)
    .bind(encrypted.accessCipher,encrypted.refreshCipher,encrypted.accessExpiresAt,encrypted.refreshExpiresAt,
      current.hash,current.authorization_epoch,now()).first();
  if(!updated)throw Error('Cloudflare authorization changed while connecting');
  return redirect('/');
}
async function accountOptions(env,current){
  const token=await getFreshAccessToken({env,session:current,provider:'cloudflare'});
  const url='https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50';
  const response=await fetch(url,{headers:{authorization:'Bearer '+token,accept:'application/json'},redirect:'manual'});
  if(!response.ok)throw Error('Unable to list accounts: check the Cloudflare OAuth permissions');
  const data=await response.json();
  if(!data.success||!Array.isArray(data.result))throw Error('Cloudflare did not return a list of accounts');
  return data.result.filter(a=>typeof a.id==='string'&&/^[a-f\d]{32}$/i.test(a.id)).map(a=>({id:a.id,name:String(a.name||a.id)}));
}
async function home(env,current,notice){
  const disconnectNotice=notice==='unconfirmed'?'<p role="alert">Your local session was removed, but one or more provider authorizations could not be revoked automatically. Review connected applications in your GitHub and Cloudflare account settings.</p>':notice==='complete'?'<p role="status">You are signed out and provider revocation was confirmed for the connected accounts.</p>':'';
  if(!current)return view('Launch your website',`${disconnectNotice}<p><strong>Describe it. Launch it. Own it.</strong></p><p>Build and maintain your own website using your GitHub and Cloudflare accounts.</p><p>Connect GitHub to get started. You approve each launch before any resources are created.</p><p><a href="/connect/github">Connect GitHub</a></p><small>We do not ask for API tokens or passwords.</small>`);
  const connected=!!current.cloudflare_token_ct;
  let accountHtml='';
  if(connected&&!current.cloudflare_account_id){
    try{
      const accounts=await accountOptions(env,current);
      accountHtml=accounts.length?`<section><h2>Choose your Cloudflare account</h2><p>Only the selected account will be used.</p>${button('/account','Select account',current.csrf,`<label for="account">Cloudflare account</label><select id="account" name="accountId" required>${accounts.map(a=>`<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('')}</select>`)}</section>`:'<p>No authorized Cloudflare accounts were found. Check the connection permissions.</p>';
    }catch{accountHtml='<p>Could not list your Cloudflare accounts. Reconnect with the required permissions.</p>';}
  }
  const siteFields=[
    '<label for="name">Business or website name</label><input id="name" name="name" maxlength="80" required placeholder="e.g. Green Willow Studio">',
    '<label for="tagline">Homepage headline</label><input id="tagline" name="tagline" maxlength="140" placeholder="e.g. Your story, beautifully told">',
    '<label for="about">Describe your business</label><textarea id="about" name="about" maxlength="650" rows="4" placeholder="What makes your business special?"></textarea>',
    '<label for="services">Services (one per line, up to six)</label><textarea id="services" name="services" rows="4" placeholder="Portraits&#10;Events&#10;Editing"></textarea>',
    '<label for="contactEmail">Contact email (optional)</label><input id="contactEmail" name="contactEmail" type="email" maxlength="254" placeholder="hello@example.com">',
    '<label for="theme">Choose a color theme</label><select id="theme" name="theme"><option value="ocean">Ocean</option><option value="forest">Forest</option><option value="sunset">Sunset</option><option value="graphite">Graphite</option></select>'
  ].join('');
  const aiFields=[
    '<label for="ai-name">Business name</label><input id="ai-name" name="name" maxlength="80" required placeholder="e.g. Green Willow Studio">',
    '<label for="ai-description">Describe your business in your own words</label><textarea id="ai-description" name="description" minlength="20" maxlength="1400" rows="5" required placeholder="Tell us what you do, who you serve, and what makes your work special. Share only details you want sent to the AI provider."></textarea>',
    '<label for="ai-theme">Color theme</label><select id="ai-theme" name="theme"><option value="ocean">Ocean</option><option value="forest">Forest</option><option value="sunset">Sunset</option><option value="graphite">Graphite</option></select>',
    '<label for="ai-email">Contact email (optional)</label><input id="ai-email" name="contactEmail" type="email" maxlength="254" placeholder="hello@example.com">'
  ].join('');
  const aiEntry=connected&&current.cloudflare_account_id&&aiDraftConfigured(env)?
    '<section><h2>Describe it. Get a draft.</h2><p>Optional AI-assisted copy: your business name and description will be sent to the configured AI provider. AI may make mistakes; you must review and edit every claim before publishing. Contact email is not sent to the model.</p>'+
    button('/draft','Draft my website copy',current.csrf,aiFields)+'</section>':'';
  const next=connected&&current.cloudflare_account_id?
    '<section><h2>Design your website</h2><p>Review your generated homepage before approving publication. Forms and custom domains remain a future beta milestone.</p>'+
    button('/preview','Generate website preview',current.csrf,siteFields)+'</section>':'';
  const historyLink=connected&&current.cloudflare_account_id?'<p><a href="/history">View previous approved launches</a></p>':'';
  return view('Website setup',`<p class="pill">GitHub connected: ${escape(current.github_login)}</p><p>Cloudflare: ${connected?'Connected':'Not connected'}${current.cloudflare_account_id?' · Account selected':''}</p>${!connected?'<p><a href="/connect/cloudflare">Connect Cloudflare</a></p>':''}${accountHtml}${aiEntry}${next}${historyLink}<section>${button('/logout','Disconnect and sign out',current.csrf)}</section>`);
}
async function selectAccount(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(!current.cloudflare_token_ct)throw Error('Connect Cloudflare before selecting an account');
  const accountId=data.get('accountId')?.toLowerCase();
  const token=await getFreshAccessToken({env,session:current,provider:'cloudflare'});
  await verifyCloudflareAccount({accessToken:token,accountId});
  const updated=await env.DB.prepare(`UPDATE onboarding_sessions SET
    authorization_epoch=authorization_epoch+(cloudflare_account_id IS NOT ?), cloudflare_account_id=?
    WHERE id_hash=? AND authorization_epoch=? AND expires_at>? RETURNING id_hash`)
    .bind(accountId,accountId,current.hash,current.authorization_epoch,now()).first();
  if(!updated)throw Error('Cloudflare authorization changed while selecting the account');
  return redirect('/');
}
async function draft(request,env,current){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(!current?.cloudflare_account_id||!current.cloudflare_token_ct)
    throw Error('Choose your authorized Cloudflare account first');
  if(!aiDraftConfigured(env))
    return fail('AI drafting is not configured. Use the manual website editor on the setup page.',503);
  let site;
  try{
    site=await draftSiteFromBrief({
      ai:env.AI,model:env.SITE_AI_MODEL,
      name:data.get('name'),description:data.get('description'),
      theme:data.get('theme')||'ocean',contactEmail:data.get('contactEmail')||''
    });
  }catch{
    // Provider error details, raw model output and submitted prompts never
    // enter logs or browser responses.
    return fail('Could not prepare an AI draft. Use the manual website editor or try again.',502);
  }
  const themes=['ocean','forest','sunset','graphite'];
  const fields=[
    '<label for="draft-name">Business name</label><input id="draft-name" name="name" required maxlength="80" value="'+escape(site.name)+'">',
    '<label for="draft-tagline">Homepage headline</label><input id="draft-tagline" name="tagline" maxlength="140" value="'+escape(site.tagline)+'">',
    '<label for="draft-about">About your business</label><textarea id="draft-about" name="about" maxlength="650" rows="5">'+escape(site.about)+'</textarea>',
    '<label for="draft-services">Services (one per line; up to six)</label><textarea id="draft-services" name="services" rows="5">'+escape(site.services.join('\n'))+'</textarea>',
    '<label for="draft-theme">Theme</label><select id="draft-theme" name="theme">'+themes.map(t=>'<option value="'+t+'"'+(t===site.theme?' selected':'')+'>'+escape(t.charAt(0).toUpperCase()+t.slice(1))+'</option>').join('')+'</select>',
    '<label for="draft-email">Contact email (optional)</label><input id="draft-email" name="contactEmail" type="email" maxlength="254" value="'+escape(site.contactEmail)+'">'
  ].join('');
  return view('Review your AI-assisted draft',
    '<p role="status">This is an editable draft, not a live website. AI can make mistakes. Review all claims and contact details before previewing or approving.</p>'+
    button('/preview','Preview this edited draft',current.csrf,fields)+
    '<p><a href="/">Return to the manual editor</a></p>');
}
async function preview(request,env,current){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(!current.cloudflare_account_id||!current.cloudflare_token_ct)throw Error('Choose your authorized Cloudflare account first');
  const site=normalizeSite({name:data.get('name'),tagline:data.get('tagline')||'',about:data.get('about')||'',
    services:data.get('services')||'',theme:data.get('theme')||'ocean',contactEmail:data.get('contactEmail')||''});
  const config={name:site.name,accountId:current.cloudflare_account_id,githubOwner:current.github_login,forms:false};
  const plan=planCustomer(config);
  const id=crypto.randomUUID(),ts=now();
  await env.DB.prepare(`INSERT INTO onboarding_launches
    (id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,created_at,updated_at,preview_html)
    VALUES(?,?,?,?,?,?,'preview',?,?,?)`)
    .bind(id,current.hash,site.name,current.cloudflare_account_id,current.github_login,
      JSON.stringify({...plan,site}),ts,ts,renderSite(site)).run();
  return redirect('/review?id='+encodeURIComponent(id));
}
async function assertHistoryAccess(env,current){
  if(!current?.cloudflare_account_id)throw Error('Reconnect GitHub and select your Cloudflare account');
  const checkSession=async()=>{
    const live=await env.DB.prepare(`SELECT 1 FROM onboarding_sessions
      WHERE id_hash=? AND authorization_epoch=? AND cloudflare_account_id=? AND expires_at>?`)
      .bind(current.hash,current.authorization_epoch,current.cloudflare_account_id,now()).first();
    if(!live)throw Error('Account authorization changed');
  };
  const fetchFn=async(url,options)=>{
    await checkSession();
    return await fetch(url,{...options,signal:AbortSignal.timeout(8000)});
  };
  const githubToken=await getFreshAccessToken({env,session:current,provider:'github',fetchFn});
  const cloudflareToken=await getFreshAccessToken({env,session:current,provider:'cloudflare',fetchFn});
  await verifyProviderConnections({name:'Launch history',githubOwner:current.github_login,accountId:current.cloudflare_account_id},{
    githubAccessToken:githubToken,cloudflareAccessToken:cloudflareToken,expectedGitHubUserId:current.github_user_id,fetchFn
  });
  await checkSession();
}

const launchIdField=id=>'<input type="hidden" name="id" value="'+escape(id)+'">';
const reviewPath=id=>'/review?id='+encodeURIComponent(id);
const receiptOwner=(current,time)=>({
  githubUserId:current.github_user_id,cloudflareAccountId:current.cloudflare_account_id,time
});

async function launchHistory(env,current){
  if(!current?.cloudflare_account_id)return fail('Connect GitHub and choose your Cloudflare account before viewing launch history.',401);
  await assertHistoryAccess(env,current);
  const time=now();
  const [jobs,legacy]=await Promise.all([listOwnedJobs(env,current,time),listOwnedReceipts(env,receiptOwner(current,time))]);
  const items=[...jobs,...legacy.map(receipt=>({
    ...receipt,site_slug:JSON.parse(receipt.plan_json).customer,display_status:receipt.status,
    can_restore:receipt.status!=='live',can_delete:true
  }))].sort((a,b)=>b.updated_at-a.updated_at).slice(0,20);
  const cards=items.map(item=>{
    const website='https://esp-'+item.site_slug+'-site.pages.dev/';
    const live=item.display_status==='live'?`<p>Verified site: <a href="${escape(website)}">${escape(website)}</a></p>`:'';
    const action=item.can_restore?button('/restore','Review and reapprove this website',current.csrf,launchIdField(item.id)):'';
    const deletion=item.can_delete?button('/delete-launch-history','Delete history entry',current.csrf,launchIdField(item.id)):'';
    const diagnostic=item.error_code?`<p>Last result: <code>${escape(item.error_code)}</code></p>`:'';
    return `<section><h2>${escape(item.customer_name)}</h2><p>Status: ${escape(item.display_status)}</p>${diagnostic}${live}${action}${deletion}</section>`;
  }).join('');
  return view('Approved website history','<p>History is retained for 30 days from the first approval. Reconnect and reapprove a paused launch to resume it. Deleting an entry leaves any customer-owned website and repository in place.</p>'+
    (cards||'<p>No approved launches found for this GitHub identity and Cloudflare account.</p>')+
    '<p><a href="/">Back to setup</a></p>');
}

async function restoreLaunch(request,env,current){
  await limitAttempts(request,env);
  const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
  await assertHistoryAccess(env,current);
  const requestedId=form.get('id'),time=now();
  const job=await getOwnedJob(env,current,requestedId,time);
  let item=job;
  let planJson=job?.plan_json;
  let html=null;
  if(job){
    if(!job.can_restore||(await approvalSnapshot(job,job.github_user_id)).digest!==job.approval_digest)
      throw Error('This launch cannot be reapproved');
  }else{
    item=await getOwnedReceipt(env,{id:requestedId,...receiptOwner(current,time)});
    if(!item||item.status==='live')throw Error('This unfinished launch is not accessible');
    const active=await env.DB.prepare(`SELECT l.id FROM onboarding_launches l
      JOIN onboarding_sessions s ON l.session_hash=s.id_hash
      WHERE l.id=? AND s.expires_at>?`).bind(item.id,time).first();
    if(active)throw Error('This legacy launch is still in its original session');
    const oldPlan=JSON.parse(item.plan_json);
    const site=normalizeSite({...oldPlan.site,name:item.customer_name});
    const plan=planCustomer({name:item.customer_name,githubOwner:item.github_login,
      accountId:item.cloudflare_account_id,forms:false});
    if(oldPlan.customer!==plan.customer)throw Error('The stored website plan has changed');
    planJson=JSON.stringify({...plan,site});
    html=renderSite(site);
  }
  if(item.github_login.toLowerCase()!==current.github_login.toLowerCase())throw Error('The GitHub target changed');
  const id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO onboarding_launches
    (id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,
      created_at,updated_at,job_id,legacy_receipt_id,preview_html)
    VALUES(?,?,?,?,?,?,'preview',?,?,?,?,?)`)
    .bind(id,current.hash,item.customer_name,item.cloudflare_account_id,item.github_login,planJson,time,time,
      job?.id??null,job?job.legacy_receipt_id:item.id,html).run();
  return redirect(reviewPath(id));
}

async function removeLaunchHistory(request,env,current){
  await limitAttempts(request,env);
  const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
  await assertHistoryAccess(env,current);
  if(!await deleteOwnedLaunch(env,current,form.get('id'),now()))throw Error('This history entry cannot be deleted');
  return redirect('/history');
}

async function getLaunch(env,current,id){
  if(!current?.cloudflare_account_id||!isLaunchId(id))return null;
  const time=now();
  const item=await env.DB.prepare(`SELECT p.*, COALESCE(j.approved_html,p.preview_html) AS approved_html,
      j.approval_digest AS saved_digest,
      j.status AS job_status, j.expected_commit_sha, j.error_code AS job_error,
      j.attempts, j.next_attempt_at,
      a.session_hash AS authorizing_session, a.authorization_epoch AS approved_epoch
    FROM onboarding_launches p
    LEFT JOIN onboarding_launch_jobs j ON j.id=p.job_id AND j.github_user_id=?
      AND j.cloudflare_account_id=p.cloudflare_account_id AND j.expires_at>?
    LEFT JOIN onboarding_launch_job_sessions a ON a.job_id=j.id
    WHERE p.id=? AND p.session_hash=? AND p.cloudflare_account_id=? AND lower(p.github_login)=lower(?)`)
    .bind(current.github_user_id,time,id,current.hash,current.cloudflare_account_id,current.github_login).first();
  return item?.job_id&&!item.saved_digest?null:item;
}

async function itemSnapshot(item,current){
  const snapshot=await approvalSnapshot(item,current.github_user_id);
  if(item.saved_digest&&snapshot.digest!==item.saved_digest)throw Error('The approval snapshot changed');
  return snapshot;
}

async function sitePreview(env,current,id){
  const item=await getLaunch(env,current,id);
  if(!item)return fail('This website preview is not accessible.',404);
  const {html}=await itemSnapshot(item,current);
  return new Response(html,{status:200,headers:{
    'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
    'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }});
}

async function review(env,current,id){
  const item=await getLaunch(env,current,id);
  if(!item)return fail('This launch request is not accessible.',404);
  const {slug,digest}=await itemSnapshot(item,current);
  const website='https://esp-'+slug+'-site.pages.dev';
  const details=`<p><strong>Name:</strong> ${escape(item.customer_name)}</p><p><strong>GitHub:</strong> ${escape(item.github_login)}</p><p><strong>Cloudflare:</strong> ${escape(item.cloudflare_account_id)}</p><p><strong>Private repository:</strong> ${escape('esp-'+slug)}</p><p><strong>Public Pages URL:</strong> ${escape(website)}</p><p>Approval allows Launch &amp; Own to create the private repository, publish the reviewed website, and retry while this session and both provider grants stay valid. Changes to the repository's production branch can trigger future Pages deployments.</p><p>Cloudflare's Workers &amp; Pages GitHub App needs access to the repository. <a href="https://github.com/settings/installations">Review GitHub App access</a>.</p>`;
  const previewLink='<p><a href="/site-preview?id='+encodeURIComponent(item.id)+'" target="_blank" rel="noopener">Open your website preview</a></p>';
  let status=item.status;
  let controls='';
  let output='';
  if(status==='preview'){
    controls=button('/approve','Approve and create website',current.csrf,launchIdField(id)+
      '<input type="hidden" name="digest" value="'+escape(digest)+'">');
  }else{
    const bound=item.authorizing_session===current.hash&&item.approved_epoch===current.authorization_epoch;
    status=item.job_status??'needs_reauthorization';
    if(!bound&&['queued','pending_deployment'].includes(status))status='needs_reauthorization';
    if(status==='queued'){
      output='<p>Your launch is queued. Refresh this page for updates.</p>';
      controls=button('/launch','Run due launch steps',current.csrf,launchIdField(id));
    }
    if(status==='pending_deployment'){
      output='<p>Cloudflare is building the approved revision.</p>';
      controls=button('/verify','Check live deployment',current.csrf,launchIdField(id));
    }
    if(['failed','needs_reauthorization'].includes(status)){
      output='<p>Launch is paused. <a href="/history">Open launch history</a> to review and reapprove it when available.</p>';
    }
    if(item.job_error)output+=`<p>Last result: <code>${escape(item.job_error)}</code></p>`;
    if(item.attempts>0&&['queued','pending_deployment'].includes(status)&&item.next_attempt_at>now()){
      const timestamp=new Date(item.next_attempt_at*1000).toISOString();
      output+=`<p>Attempts used: ${escape(item.attempts)}. Next eligible retry <time datetime="${timestamp}">${timestamp}</time>.</p>`;
    }
    if(status==='live')output=`<p class="pill">Public website deployment verified</p><p><a href="${escape(website)}">${escape(website)}</a></p><p>Verified revision <code>${escape(item.expected_commit_sha)}</code></p>`;
  }
  return view('Review website launch',`${details}<p class="pill">Status: ${escape(status)}</p>${previewLink}${output}${controls}<p><a href="/">Back to setup</a></p>`);
}

function queueAttempt(context,env,id,sessionHash){
  context?.waitUntil(runLaunchJob(env,id,sessionHash).catch(()=>{
    console.error(JSON.stringify({event:'onboarding_launch_error',code:'runner_unavailable'}));
  }));
}

async function approve(request,env,current,context){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  const item=await getLaunch(env,current,data.get('id'));
  if(!item||item.status!=='preview')throw Error('This launch is not awaiting approval');
  const snapshot=await itemSnapshot(item,current);
  if(data.getAll('digest').length!==1||data.get('digest')!==snapshot.digest)throw Error('Review the current website preview again');
  const time=now();
  const receipt=item.legacy_receipt_id&&!item.job_id
    ?await getOwnedReceipt(env,{id:item.legacy_receipt_id,...receiptOwner(current,time)}):null;
  if(item.legacy_receipt_id&&!item.job_id&&!receipt)throw Error('This history entry expired');
  if(!await approveJob(env,{preview:item,session:current,snapshot,receipt,time}))
    return fail('This launch changed or its target already has an approved launch. Check launch history.',409);
  queueAttempt(context,env,snapshot.id,current.hash);
  return redirect(reviewPath(item.id));
}

async function runDueStep(request,env,current,context,status){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  const item=await getLaunch(env,current,data.get('id'));
  if(item?.status!=='approved'||item.job_status!==status||item.authorizing_session!==current.hash||
      item.approved_epoch!==current.authorization_epoch)throw Error('This launch step is not authorized');
  queueAttempt(context,env,item.job_id,current.hash);
  return redirect(reviewPath(item.id));
}

async function logout(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  // Delete the local session BEFORE attempting any external revocation.
  // Cascading the job binding immediately fences stale runners as well.
  const removed=await env.DB.prepare(`DELETE FROM onboarding_sessions WHERE id_hash=? RETURNING
    github_token_ct, cloudflare_token_ct, github_refresh_locked_until, cloudflare_refresh_locked_until`)
    .bind(current.hash).first();
  let fullyRevoked=false;
  try{
    const githubToken=await unseal(env.TOKEN_ENCRYPTION_KEY,removed.github_token_ct,'github:'+current.hash);
    const cloudflareToken=removed.cloudflare_token_ct
      ?await unseal(env.TOKEN_ENCRYPTION_KEY,removed.cloudflare_token_ct,'cloudflare:'+current.hash):null;
    const results=await revokeConnectedAccounts({
      githubToken,cloudflareToken,ghClientId:env.GH_CLIENT_ID,ghClientSecret:env.GH_CLIENT_SECRET,
      cfClientId:env.CF_CLIENT_ID,cfClientSecret:env.CF_CLIENT_SECRET
    });
    fullyRevoked=results.fullyRevoked&&!(removed.github_refresh_locked_until||removed.cloudflare_refresh_locked_until);
  }catch{/* Local sign-out is already complete. */}
  const result=redirect(fullyRevoked?'/?disconnect=complete':'/?disconnect=unconfirmed');
  result.headers.append('set-cookie',cookie(COOKIE_SESSION,'',0));
  result.headers.append('set-cookie',cookie(COOKIE_LOGIN,'',0));
  return result;
}
export default {
  async fetch(request,env,context){
    try{
      const url=new URL(request.url);
      if(url.pathname==='/health'&&request.method==='GET'){
        let hasConfiguration=true;
        try{configured(env)}catch{hasConfiguration=false}
        const launchJobsReady=await launchSchemaReady(env.DB);
        return Response.json({ok:launchJobsReady,configured:hasConfiguration,launchJobsReady},{
          status:launchJobsReady?200:503,headers:{'cache-control':'no-store'}
        });
      }
      // Public legal pages: linked from the provider consent screens, so they need no session or configuration.
      if(request.method==='GET'&&url.pathname==='/privacy')return view('Privacy Policy',privacyHtml);
      if(request.method==='GET'&&url.pathname==='/terms')return view('Terms of Service',termsHtml);
      if(request.method==='GET'&&url.pathname==='/logo.png')return new Response(Uint8Array.from(atob(LOGO_PNG_BASE64),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png','cache-control':'public, max-age=86400','x-content-type-options':'nosniff'}});
      configured(env);
      if(url.origin!==baseUrl(env))return fail('This service requires its registered HTTPS origin.',400);
      const current=await session(request,env);
      if(request.method==='GET'){
        if(url.pathname==='/')return await home(env,current,url.searchParams.get('disconnect'));
        if(url.pathname==='/connect/github')return await gitHubStart(request,env);
        if(url.pathname==='/oauth/github/callback')return await gitHubCallback(request,env,current);
        if(url.pathname==='/connect/cloudflare')return await cloudflareStart(request,env,current);
        if(url.pathname==='/oauth/cloudflare/callback')return await cloudflareCallback(request,env,current);
        if(url.pathname==='/review')return await review(env,current,url.searchParams.get('id'));
        if(url.pathname==='/history')return await launchHistory(env,current);
        if(url.pathname==='/site-preview')return await sitePreview(env,current,url.searchParams.get('id'));
      }
      if(request.method==='POST'){
        if(url.pathname==='/account')return await selectAccount(request,env,current);
        if(url.pathname==='/preview')return await preview(request,env,current);
        if(url.pathname==='/draft')return await draft(request,env,current);
        if(url.pathname==='/approve')return await approve(request,env,current,context);
        if(url.pathname==='/launch')return await runDueStep(request,env,current,context,'queued');
        if(url.pathname==='/verify')return await runDueStep(request,env,current,context,'pending_deployment');
        if(url.pathname==='/logout')return await logout(request,env,current);
        if(url.pathname==='/restore')return await restoreLaunch(request,env,current);
        if(url.pathname==='/delete-launch-history')return await removeLaunchHistory(request,env,current);
      }
      return fail('Page not found',404);
    }catch(error){
      // Never log bearer tokens, OAuth codes, cookie values or request bodies.
      const code=error?.message==='Onboarding account connections are not configured'?'not_configured':'request_rejected';
      console.error(JSON.stringify({event:'onboarding_request_error',code}));
      return fail(code==='not_configured'?'Account connections are being configured.':'This request could not be completed. Refresh and try again.',code==='not_configured'?503:400);
    }
  },
  async scheduled(_event,env){
    try{
      configured(env);
      await runScheduledLaunches(env);
    }finally{
      const expired=now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM onboarding_flows WHERE expires_at<=?').bind(expired),
        env.DB.prepare('DELETE FROM onboarding_sessions WHERE expires_at<=?').bind(expired)
      ]);
      await purgeExpiredReceipts(env,expired);
    }
  }
};
