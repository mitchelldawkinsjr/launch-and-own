import {AsyncLocalStorage} from 'node:async_hooks';
import {beginGitHubAppOAuth,completeGitHubAppOAuth} from '../pipeline/github-app-oauth.mjs';
import {
  CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
  githubAppCanCreateRepositories,
  githubAppInstalledOnUser,
  githubAppInstallUrl,
  listUserGithubAppInstallations
} from '../pipeline/github-app-installation.mjs';
import {beginCloudflareOAuth,completeCloudflareOAuth,verifyCloudflareAccount,verifyCloudflarePagesAccess} from '../pipeline/cloudflare-oauth.mjs';
import {verifyProviderConnections} from '../pipeline/authorization-checks.mjs';
import {ProviderRequestError} from '../pipeline/provider-errors.mjs';
import {ToolkitApprovalExecutionError} from '../pipeline/approved-extension-consumer.mjs';
import {ExtensionProviderError} from '../pipeline/cloudflare-extension-provider.mjs';
import {planCustomer} from '../pipeline/plan-customer.mjs';
import {normalizeSite,renderSite} from '../site/render-site.mjs';
import {draftSiteFromBrief,aiDraftConfigured} from '../site/draft-site.mjs';
import {randomToken,sha256,seal,unseal} from './crypto.mjs';
import {revokeConnectedAccounts} from './revoke-connections.mjs';
import {encryptGrant,getFreshAccessToken} from './token-lifecycle.mjs';
import {listOwnedReceipts,getOwnedReceipt,purgeExpiredReceipts} from './launch-receipts.mjs';
import {privacyHtml,termsHtml} from './legal-pages.mjs';
import {LOGO_PNG_BASE64} from './logo.mjs';
import {approvalSnapshot,approveJob,deleteOwnedLaunch,getOwnedJob,hasCurrentOwnerSession,isLaunchId,listOwnedJobs} from './launch-jobs.mjs';
import {createSiteOptionsRoutes} from './post-launch-options.mjs';
import {executeOwnedStoredOption,FormsConsentRequired,OptionExecutionDisabled} from './execute-option.mjs';
import {mintOwnerExecutionGrant,OWNER_FORMS_DEFAULTS,ownerSelfActivationEnabled,storeOwnerFormsCostPrivacy} from './owner-option-activation.mjs';
import {readOwnedStoredOptionApproval} from './stored-option-approvals.mjs';
import {launchSchemaReady} from './launch-schema.mjs';
import {runLaunchJob,runScheduledLaunches} from './run-launch-jobs.mjs';
import {extractWebsiteZip,MAX_ZIP_BYTES,readBounded,WebsiteZipError} from './website-zip.mjs';
import {loadZipFiles,readZipManifest,retainZip,stageZip} from './zip-artifacts.mjs';
import {inspectSite} from '../imported/intelligence.mjs';
import {importReportMarkup} from './import-report.mjs';
import {createZipPreview,zipPreviewConfigured} from './zip-preview-access.mjs';
import {showAgentLink,confirmAgentLink} from './agent-link.mjs';
import {bridgeLaunchStatus,importBridgeDraft} from './bridge-draft-review.mjs';
import {createImportedEditRoutes} from './imported-edit-flow.mjs';
import {readFormService} from './form-service.mjs';
import {FormMessagesUnavailable,messagesProblem,readFormMessages,renderFormMessages} from './form-messages.mjs';
import {createSiteUpdateRoutes} from './site-update-flow.mjs';
import {createSiteFilesRoutes} from './site-files-flow.mjs';
import {loadToolkitCards,renderToolkitPage} from './post-launch-toolkit.mjs';
import {providerConnectionCards,providerHelpCss} from './provider-connection-help.mjs';
import {pageShell} from './ui.mjs';
import {landingCss,landingMarkup,zipCompatibilityHtml} from './landing.mjs';
import {connectPagesAccess,getPagesAccess,removePagesAccess,PagesAccessChanged} from './pages-access.mjs';
import {isPagesAccessError,pagesAccessLink,pagesAccessPath,renderPagesAccess} from './pages-access-view.mjs';
import {
  loadCurrentManagedSitesPage,renderCurrentSitesSection,currentSiteDetails,
  inspectSealedManagedSource,renderCurrentSourcePage
} from './toolkit-current-sites.mjs';
import {recordFunnel,countryFromRequest} from './funnel-analytics.mjs';
import {
  assistantScopes,assistantScopesGranted,createAssistantSetupRoutes,toolkitAssistantCta
} from './assistant-setup.mjs';

const COOKIE_SESSION='__Host-esp_session';
const COOKIE_LOGIN='__Host-esp_login';
const COOKIE_ASSISTANT_JOB='__Host-esp_asst_job';
const COOKIE_FORMS_JOB='__Host-esp_forms_job';
// Cloudflare Web Analytics only (cookieless). No Google/third-party ad trackers.
const textHeaders={
  'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'x-frame-options':'DENY','x-content-type-options':'nosniff',
  // same-origin, not no-referrer: under no-referrer Chrome sends `Origin: null` on form POSTs, failing assertCsrf.
  'referrer-policy':'same-origin',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const requestUi=new AsyncLocalStorage();
const now=()=>Math.floor(Date.now()/1000);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookie=(name,value,maxAge)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const redirect=(path,setCookie)=>{
  const headers=new Headers({'location':path,'cache-control':'no-store','referrer-policy':'same-origin'});
  for(const c of [].concat(setCookie||[]).filter(Boolean))headers.append('set-cookie',c);
  return new Response(null,{status:303,headers});
};
// opts are UI-only (pageShell); never pass them as the headers argument.
const view=(title,body,status=200,headers=textHeaders,opts={})=>new Response(
  pageShell({title,body,...opts,css:providerHelpCss+(opts.css||''),
    analyticsToken:opts.analyticsToken??requestUi.getStore()?.analyticsToken??''}),
  {status,headers:headers||textHeaders});
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
  for(const key of ['DB','TOKEN_ENCRYPTION_KEY','GH_CLIENT_ID','GH_CLIENT_SECRET','GH_APP_SLUG','CF_CLIENT_ID','CF_CLIENT_SECRET','CF_SCOPES','ONBOARDING_LIMITER']){
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
    cloudflare_account_id, cloudflare_forms_grant, cloudflare_assistant_grant, csrf_ct, expires_at, authorization_epoch FROM onboarding_sessions
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
  const bytes=await readBounded(request.body,4096);
  if(!bytes)throw Error('Form submission is too large');
  return new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
async function saveFlow(env,{provider,binding,state,codeVerifier,purpose='sign_in'}){
  const key=await sha256(state);
  const bindingHash=await sha256(binding);
  const ciphertext=await seal(env.TOKEN_ENCRYPTION_KEY,codeVerifier,'flow:'+key);
  await env.DB.prepare('INSERT INTO onboarding_flows(state_hash,provider,binding_hash,verifier_ct,expires_at,purpose) VALUES(?,?,?,?,?,?)')
    .bind(key,provider,bindingHash,ciphertext,now()+600,purpose).run();
}
async function consumeFlow(env,{provider,binding,state}){
  if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state)||!binding)throw Error('Missing or expired authorization');
  const key=await sha256(state);
  const bindingHash=await sha256(binding);
  // Single atomic update: another callback cannot reuse the same authorization attempt.
  const row=await env.DB.prepare('UPDATE onboarding_flows SET consumed_at=? WHERE state_hash=? AND provider=? AND binding_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING verifier_ct, purpose')
    .bind(now(),key,provider,bindingHash,now()).first();
  if(!row)throw Error('Authorization expired or already used');
  return {verifier:await unseal(env.TOKEN_ENCRYPTION_KEY,row.verifier_ct,'flow:'+key),purpose:row.purpose};
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
  recordFunnel(env,'start_github',{country:countryFromRequest(request),path:'/connect/github'});
  return redirect(authorizationUrl,cookie(COOKIE_LOGIN,nonce,600));
}
async function gitHubCallback(request,env,current){
  const url=new URL(request.url);
  if(url.searchParams.has('error'))return fail('GitHub authorization was cancelled. You can try again.');
  const nonce=cookies(request)[COOKIE_LOGIN];
  const {verifier}=await consumeFlow(env,{provider:'github',binding:nonce,state:url.searchParams.get('state')});
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
  recordFunnel(env,'github_ok',{country:countryFromRequest(request),path:'/oauth/github/callback'});
  const response=redirect('/');
  response.headers.append('set-cookie',cookie(COOKIE_SESSION,raw,3600));
  response.headers.append('set-cookie',cookie(COOKIE_LOGIN,'',0));
  return response;
}
// D1 and Workers scope IDs come from the Cloudflare OAuth client registration (Domain).
// Incremental consent (owner-approved 2026-11-26): they are requested only in the separate forms consent
// (/connect/cloudflare?purpose=forms), never at sign-in. Assistant setup uses purpose=assistant the same way.
// A malformed ID is dropped rather than sent.
export function formsScopes(env){
  return env.OPTION_FORMS_ENABLED==='true'?String(env.CF_FORMS_SCOPES||'').trim().split(/\s+/)
    .filter(scope=>scope==='workers-scripts.admin'||/^[a-z0-9-]+\.(?:read|write)$/.test(scope)):[];
}
export {assistantScopes,assistantScopesGranted};
export function cloudflareScopes(env,{forms=false,assistant=false}={}){
  const scopes=String(env.CF_SCOPES).trim().split(/\s+/);
  return [...new Set([
    ...scopes,
    ...(forms?formsScopes(env):[]),
    ...(assistant?assistantScopes(env):[])
  ])];
}
export function formsScopesGranted(env,scope){
  // Cloudflare may omit the scope string; then the forms consent request is what was approved.
  if(typeof scope!=='string'||!scope.trim())return true;
  const granted=new Set(scope.trim().split(/\s+/));
  return formsScopes(env).every(s=>granted.has(s));
}
function cloudflarePurpose(request,env){
  const asked=new URL(request.url).searchParams.get('purpose');
  if(asked==='forms'&&formsScopes(env).length)return 'forms';
  if(asked==='assistant'&&assistantScopes(env).length)return 'assistant';
  return 'sign_in';
}
async function cloudflareStart(request,env,current){
  await limitAttempts(request,env);
  if(!current)return fail('Connect GitHub before connecting Cloudflare.',401);
  const purpose=cloudflarePurpose(request,env);
  const origin=baseUrl(env),scopes=cloudflareScopes(env,{
    forms:purpose==='forms',assistant:purpose==='assistant'
  });
  const {authorizationUrl,session:flow}=beginCloudflareOAuth({clientId:env.CF_CLIENT_ID,redirectUri:origin+'/oauth/cloudflare/callback',scopes});
  await saveFlow(env,{provider:'cloudflare',binding:current.hash,...flow,purpose});
  if(purpose==='sign_in')recordFunnel(env,'start_cloudflare',{country:countryFromRequest(request),path:'/connect/cloudflare'});
  // Resume the selected site after incremental consent.
  let extraCookie=null;
  if(purpose==='assistant'||purpose==='forms'){
    const jobId=new URL(request.url).searchParams.get('job');
    const name=purpose==='assistant'?COOKIE_ASSISTANT_JOB:COOKIE_FORMS_JOB;
    extraCookie=isLaunchId(jobId)
      ?cookie(name,jobId,600)
      :cookie(name,'',0);
  }
  return redirect(authorizationUrl,extraCookie);
}
async function cloudflareCallback(request,env,current){
  if(!current)return fail('Your session expired. Connect GitHub again.',401);
  const url=new URL(request.url);
  if(url.searchParams.has('error'))return fail('Cloudflare authorization was cancelled. You can try again.');
  const {verifier,purpose}=await consumeFlow(env,{provider:'cloudflare',binding:current.hash,state:url.searchParams.get('state')});
  const token=await completeCloudflareOAuth({clientId:env.CF_CLIENT_ID,clientSecret:env.CF_CLIENT_SECRET,redirectUri:baseUrl(env)+'/oauth/cloudflare/callback',code:url.searchParams.get('code'),receivedState:url.searchParams.get('state'),expectedState:url.searchParams.get('state'),codeVerifier:verifier});
  const encrypted=await encryptGrant({grant:token,provider:'cloudflare',sessionHash:current.hash,encryptionKey:env.TOKEN_ENCRYPTION_KEY});
  const formsGrant=purpose==='forms'&&formsScopesGranted(env,token.scope)?1:0;
  const assistantGrant=purpose==='assistant'&&assistantScopesGranted(env,token.scope)?1:0;
  // Incremental consent keeps the selected account; only a full Cloudflare reconnect clears it.
  const keepAccount=purpose==='forms'||purpose==='assistant';
  const updated=await env.DB.prepare(`UPDATE onboarding_sessions SET cloudflare_token_ct=?, cloudflare_refresh_token_ct=?,
    cloudflare_token_expires_at=?, cloudflare_refresh_expires_at=?, cloudflare_refresh_locked_until=NULL,
    cloudflare_account_id=${keepAccount?'cloudflare_account_id':'NULL'}, cloudflare_forms_grant=?, cloudflare_assistant_grant=?,
    authorization_epoch=authorization_epoch+1
    WHERE id_hash=? AND authorization_epoch=? AND expires_at>? RETURNING id_hash`)
    .bind(encrypted.accessCipher,encrypted.refreshCipher,encrypted.accessExpiresAt,encrypted.refreshExpiresAt,
      formsGrant,assistantGrant,current.hash,current.authorization_epoch,now()).first();
  if(!updated)throw Error('Cloudflare authorization changed while connecting');
  if(purpose==='sign_in')recordFunnel(env,'cloudflare_ok',{country:countryFromRequest(request),path:'/oauth/cloudflare/callback'});
  if(purpose==='assistant'){
    const jobId=cookies(request)[COOKIE_ASSISTANT_JOB];
    const clear=cookie(COOKIE_ASSISTANT_JOB,'',0);
    if(isLaunchId(jobId))return redirect('/assistant-setup?id='+encodeURIComponent(jobId),clear);
    return redirect('/toolkit',clear);
  }
  if(purpose==='forms'){
    const jobId=cookies(request)[COOKIE_FORMS_JOB];
    const clear=cookie(COOKIE_FORMS_JOB,'',0);
    return redirect(isLaunchId(jobId)?'/site-options?id='+encodeURIComponent(jobId):'/',clear);
  }
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
async function home(env,current,notice,request){
  const disconnectNotice=notice==='unconfirmed'?'<p role="alert">You are signed out here, but GitHub or Cloudflare may still show Launch &amp; Own as connected. Open your account settings on those sites and remove access if you want a full disconnect.</p>':notice==='complete'?'<p role="status">You are signed out, and GitHub and Cloudflare confirmed that Launch &amp; Own OAuth access was removed.</p>':'';
  const zipEnabled=zipPreviewConfigured(env);
  if(!current){
    recordFunnel(env,'land',{country:countryFromRequest(request),path:'/'});
    return view('Launch your website',landingMarkup({zipEnabled,setupHtml:`${disconnectNotice}<p>Nothing is published until you review a preview and approve it.</p>${providerConnectionCards()}<small>Sign in on GitHub and Cloudflare. Keep credentials out of chat.</small>`}),200,textHeaders,
      {css:providerHelpCss+landingCss,wide:true,omitTitle:true,nav:'marketing'});
  }
  let appInstalled=false;
  let pagesAppInstalled=false;
  try{
    const githubToken=await getFreshAccessToken({env,session:current,provider:'github'});
    const installations=await listUserGithubAppInstallations({accessToken:githubToken});
    appInstalled=await githubAppCanCreateRepositories({
      accessToken:githubToken,appSlug:env.GH_APP_SLUG,githubLogin:current.github_login,installations
    });
    pagesAppInstalled=githubAppInstalledOnUser({
      installations,appSlug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,githubLogin:current.github_login
    });
  }catch{appInstalled=false;pagesAppInstalled=false;}
  // Required callout only when the Workers & Pages app is missing. Once installed, stay quiet.
  const pagesHint=appInstalled&&!pagesAppInstalled
    ?`<div class="lo-callout lo-callout-warn" role="status"><p class="eyebrow"><span class="lo-badge">Required</span></p>`+
      `<p><strong>Install Cloudflare's Workers &amp; Pages GitHub app</strong> on this account (separate from Launch &amp; Own). Without it, Pages cannot publish your site.</p>`+
      `<p class="tk-actions"><a class="btn" href="${escape(githubAppInstallUrl(CLOUDFLARE_WORKERS_PAGES_APP_SLUG))}">Install Workers &amp; Pages app</a></p>`+
      `<p class="muted">Install once with access to each site folder, then refresh this page.</p></div>`
    :'';
  const installHtml=appInstalled?'':`<p role="alert">One more GitHub step: install the Launch &amp; Own app so it can create a private place for your website files. Signing in alone is not enough.</p><p><a href="${escape(githubAppInstallUrl(env.GH_APP_SLUG))}">Install Launch &amp; Own on GitHub</a></p><p>After you install it, come back here and refresh the page.</p>`;
  const connected=!!current.cloudflare_token_ct;
  let accountHtml='';
  if(appInstalled&&connected&&!current.cloudflare_account_id){
    try{
      const accounts=await accountOptions(env,current);
      accountHtml=accounts.length?`<section><h2>Choose your Cloudflare account</h2><p>Pick the account that should host your public website. Only the one you select is used.</p>${button('/account','Use this account',current.csrf,`<label for="account">Cloudflare account</label><select id="account" name="accountId" required>${accounts.map(a=>`<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('')}</select>`)}</section>`:'<p>No Cloudflare accounts came back from this connection. Reconnect Cloudflare and allow account access.</p>';
    }catch{accountHtml='<p>Could not load your Cloudflare accounts. Reconnect Cloudflare and try again.</p>';}
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
  const ready=appInstalled&&connected&&current.cloudflare_account_id;
  const aiEntry=ready&&aiDraftConfigured(env)?
    '<section><h2>Optional: get help with the wording</h2><p>Describe your business and we will suggest homepage text. Your business name and description are sent to the AI service; your contact email is not. Read every line before you publish. AI can get details wrong.</p>'+
    button('/draft','Draft my website copy',current.csrf,aiFields)+'</section>':'';
  const zipEntry=ready&&zipEnabled?`<section><h2>Upload a website you already built</h2>
    <p>Upload a ZIP of your finished site for a private preview. Put <code>index.html</code> and its files at the top of the ZIP, or inside one folder.</p>
    <details><summary>What kind of website can I bring?</summary>${zipCompatibilityHtml}</details>
    <form method="POST" action="/upload" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${escape(current.csrf)}">
    <label for="zip-name">Business or website name</label><input id="zip-name" name="name" maxlength="80" required>
    <label for="website-zip">Website ZIP (up to 6 MB)</label><input id="website-zip" name="zip" type="file" accept=".zip,application/zip" required>
    <button type="submit">Upload and preview</button></form></section>`:'';
  const next=ready?
    '<section><h2>Create a simple website</h2><p>Preview first. You approve in a separate step before anything goes live.</p>'+
    button('/preview','Preview my website',current.csrf,siteFields)+'</section>':'';
  const historyLink=ready
    ?'<div class="lo-callout lo-callout-ok"><strong>After a verified launch</strong>, open the toolkit for updates and optional features.</div>'+
      '<p class="tk-actions"><a class="btn-secondary btn" href="/toolkit">Your website toolkit</a> '+
      '<a class="btn-secondary btn" href="/history">Your launches</a> '+pagesAccessLink+'</p>'
    :'';
  const cloudflareLine=connected
    ?(current.cloudflare_account_id?'Cloudflare connected · hosting account selected':'Cloudflare connected · choose your hosting account next')
    :'Cloudflare not connected yet';
  const dashboardHero=ready
    ?`<div class="lo-hero" aria-labelledby="dash-hero-title"><p class="eyebrow"><span class="lo-badge lo-badge-lo">Direct provider ownership</span><span class="lo-badge lo-badge-gh">GitHub</span><span class="lo-badge lo-badge-cf">Cloudflare</span></p><h2 id="dash-hero-title">Your digital footprint</h2><p>Accounts connected. Create or upload a site, then own it from the toolkit after launch.</p></div><div class="lo-stat-grid" role="group" aria-label="Connection status"><div class="lo-stat"><span>GitHub</span><strong>${escape(current.github_login)}</strong><p>Connected</p></div><div class="lo-stat"><span>Cloudflare</span><strong>${current.cloudflare_account_id?'Selected':'Next'}</strong><p>${escape(cloudflareLine)}</p></div><div class="lo-stat"><span>Ownership</span><strong>Yours</strong><p>No stored passwords · direct provider control</p></div></div>`
    :`<p class="pill">GitHub connected: ${escape(current.github_login)}</p>`;
  return view('Website setup',`${dashboardHero}${installHtml}${pagesHint}${providerConnectionCards({githubStatus:'connected',githubLogin:current.github_login,githubAppInstalled:appInstalled,cloudflareStatus:connected?'connected':appInstalled?'next':'later',cloudflareAccountSelected:Boolean(current.cloudflare_account_id)})}${ready?'':`<p>${cloudflareLine}</p>`}${accountHtml}${zipEntry}${aiEntry}${next}${historyLink}<section class="lo-disconnect">${button('/logout','Disconnect and sign out',current.csrf)}</section>`,200,textHeaders,
    {step:ready?'create':'connect',current:'/'});
}

async function toolkit(env,current,request){
  if(!current?.cloudflare_account_id)
    return renderToolkitPage([],current,{view,escape});
  const grants=await assertHistoryAccess(env,current);
  const cards=await loadToolkitCards(env,current,now());
  const page=Number(new URL(request.url).searchParams.get('page')||'1');
  const inventory=await loadCurrentManagedSitesPage(env,current,{page,...grants});
  if(['authorization_changed','github_reauthorization_required',
    'provider_reauthorization_required'].includes(inventory.code)||!await hasCurrentOwnerSession(env,current,now()))
    return fail('Reconnect your accounts to view your website toolkit.',401);
  // One card per site: details found in the accounts join the matching launch card.
  const found=new Map((inventory.status==='unavailable'?[]:inventory.sites||[])
    .filter(site=>site.repositoryName?.startsWith('esp-')).map(site=>[site.repositoryName.slice(4),site]));
  const siteDetails=new Map(cards.filter(card=>found.has(card.slug)).map(card=>[card.slug,currentSiteDetails(found.get(card.slug),escape)]));
  return renderToolkitPage(cards,current,{view,escape},{
    siteDetails,
    currentInventoryHtml:['cloudflare_reauthorization_required','cloudflare_permission_denied'].includes(inventory.code)
      ? '<p>Cloudflare Pages access is unavailable. '+pagesAccessLink+' to verify your sites.</p>'
      : renderCurrentSitesSection(inventory,{escape},{hasCards:cards.length>0,matched:new Set([...siteDetails.keys()].map(slug=>'esp-'+slug))})
  });
}
// Read-only inbox: the owner's own customer D1, read with the owner's grant, never stored here.
const formsConsentPage=(view,what)=>view('Allow form setup in Cloudflare',
  '<p>'+what+' needs extra permission in your Cloudflare account: to create your form\'s small Worker and its private messages database, and to read those messages.</p>'+
  '<p>Launch &amp; Own asks for this only when you use contact forms, not when you sign in. Cloudflare shows the exact permissions before you agree. You can remove them later in your Cloudflare account under <strong>My Profile → Access Management</strong>.</p>'+
  '<p><a class="btn" href="/connect/cloudflare?purpose=forms">Allow form setup in Cloudflare</a></p>'+
  '<p>After approving access, return to your site’s Optional features to continue.</p>'+
  '<p><a href="/toolkit">Back to toolkit</a></p>',403);
async function formMessages(env,current,id){
  if(!current?.cloudflare_account_id||!isLaunchId(id))return fail('Open a live website you own from your toolkit.',404);
  const job=await getOwnedJob(env,current,id,now());
  if(!job||job.status!=='live'||job.github_user_id!==current.github_user_id||job.cloudflare_account_id!==current.cloudflare_account_id)
    return fail('Open a live website you own from your toolkit.',404);
  const grants=await assertHistoryAccess(env,current);
  const service=await readFormService(env,current,job.id);
  const back='<p><a href="/site-options?id='+encodeURIComponent(job.id)+'">Optional features</a> · <a href="/toolkit">Toolkit</a></p>';
  if(!service)return view('Messages for '+job.customer_name,'<p>'+escape(messagesProblem('form_service_not_ready'))+'</p>'+back);
  if(current.cloudflare_forms_grant!==1)return formsConsentPage(view,'Reading your messages');
  try{
    const messages=await readFormMessages({accountId:current.cloudflare_account_id,databaseId:service.databaseId,
      cloudflareToken:grants.cloudflareAccessToken});
    return view('Messages for '+job.customer_name,renderFormMessages(messages,{escape,databaseName:'esp-'+job.site_slug+'-site-forms'})+back);
  }catch(error){
    if(!(error instanceof FormMessagesUnavailable))throw error;
    return view('Messages for '+job.customer_name,'<p role="alert">'+escape(messagesProblem(error.code))+'</p>'+back,503);
  }
}
async function toolkitSource(env,current,request){
  if(!current?.cloudflare_account_id)
    return renderCurrentSourcePage({status:'unavailable',code:'verified_owner_required'},{view,escape});
  const params=new URL(request.url).searchParams;
  const ticket=params.get('ticket');
  const inspection=await inspectSealedManagedSource(env,current,ticket,{check:params.get('check')||'deployment'});
  if(['authorization_changed','github_reauthorization_required',
    'provider_reauthorization_required'].includes(inspection.code)||!await hasCurrentOwnerSession(env,current,now()))
    return fail('Reconnect your accounts to view your website toolkit.',401);
  if(['cloudflare_reauthorization_required','cloudflare_permission_denied'].includes(inspection.code))
    return view('Site toolkit','<p>Cloudflare Pages access is unavailable. '+pagesAccessLink+' to check this site.</p>',401);
  return renderCurrentSourcePage(inspection,{view,escape},ticket);
}
async function selectAccount(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(!current.cloudflare_token_ct||data.getAll('accountId').length!==1)throw Error('Select a connected Cloudflare account');
  const accountId=data.get('accountId')?.toLowerCase();
  const token=await getFreshAccessToken({env,session:current,provider:'cloudflare'});
  await verifyCloudflareAccount({accessToken:token,accountId});
  let pagesDenied=false;
  try{
    await verifyCloudflarePagesAccess({accessToken:token,accountId,strict:true});
  }catch(error){
    if(!(error instanceof ProviderRequestError)||!error.authorizationLost)throw error;
    pagesDenied=true;
  }
  const updated=await env.DB.prepare(`UPDATE onboarding_sessions SET
    authorization_epoch=authorization_epoch+(cloudflare_account_id IS NOT ?), cloudflare_account_id=?
    WHERE id_hash=? AND authorization_epoch=? AND expires_at>? RETURNING id_hash`)
    .bind(accountId,accountId,current.hash,current.authorization_epoch,now()).first();
  if(!updated)throw Error('Cloudflare authorization changed while selecting the account');
  recordFunnel(env,'account_selected',{country:countryFromRequest(request),path:'/account'});
  return redirect(pagesDenied?pagesAccessPath:'/');
}

async function pagesAccessPage(env,current,problem){
  if(!current?.cloudflare_account_id)return fail('Select your Cloudflare account first.',401);
  return renderPagesAccess(current,await getPagesAccess(env,current),{view,escape,button},problem);
}

async function setPagesAccess(request,env,current){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(data.size!==3||data.getAll('mode').length!==1||data.getAll('token').length!==1)
    return fail('Choose Pages access and enter a Cloudflare API token.');
  await assertHistoryAccess(env,current);
  try{
    if(!await connectPagesAccess(env,current,{token:data.get('token'),mode:data.get('mode')}))
      return await pagesAccessPage(env,current,{message:'Enter a valid Pages API token and choose its access mode.',status:400});
  }catch(error){
    if(error instanceof PagesAccessChanged)return fail('Pages access changed. Reopen your connection and try again.',409);
    if(!(error instanceof ProviderRequestError))throw error;
    return await pagesAccessPage(env,current,{
      message:'Cloudflare could not read Pages for this account. Check the token’s account, Pages permission, and expiration. '+error.code,
      status:error.retryable?503:400
    });
  }
  return redirect(pagesAccessPath);
}

async function clearPagesAccess(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  const accessId=data.get('accessId');
  if(!current.cloudflare_account_id||data.size!==2||!isLaunchId(accessId))
    return fail('Open your Pages connection and try again.');
  await removePagesAccess(env,current,accessId);
  return redirect(pagesAccessPath);
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
    '<p role="status">This is a draft you can edit. It is not live yet. Check every claim and contact detail before you preview or approve.</p>'+
    button('/preview','Preview this edited draft',current.csrf,fields)+
    '<p><a href="/">Back to the form without AI help</a></p>');
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
      JSON.stringify({...plan,site,analytics:true}),ts,ts,renderSite(site)).run();
  recordFunnel(env,'preview',{country:countryFromRequest(request),path:'/preview'});
  return redirect('/review?id='+encodeURIComponent(id));
}
async function uploadZip(request,env,current){
  if(!zipPreviewConfigured(env))return fail('Website ZIP uploads are unavailable.',503);
  if(!current?.cloudflare_account_id||!current.cloudflare_token_ct||request.headers.get('origin')!==baseUrl(env))
    return fail('Connect GitHub and select your Cloudflare account before uploading.',403);
  await limitAttempts(request,env);
  const type=request.headers.get('content-type')||'';
  if(!/^multipart\/form-data;/i.test(type))return fail('Choose a website ZIP to upload.');
  const bodyLimit=MAX_ZIP_BYTES+64*1024;
  if(Number(request.headers.get('content-length'))>bodyLimit)return fail('Choose a ZIP file that is 6 MiB or less.',413);
  const bytes=await readBounded(request.body,bodyLimit);
  if(!bytes)return fail('Choose a ZIP file that is 6 MiB or less.',413);
  const data=await new Response(bytes,{headers:{'content-type':type}}).formData();
  assertCsrf(request,data,current,baseUrl(env));
  const archive=data.get('zip');
  if(data.getAll('zip').length!==1||!(archive instanceof File)||!archive.size)return fail('Choose a website ZIP to upload.');
  if(archive.size>MAX_ZIP_BYTES)return fail('Choose a ZIP file that is 6 MiB or less.',413);
  const nameValue=data.get('name');
  if(data.getAll('name').length!==1||typeof nameValue!=='string'||nameValue.length>80||!/[a-z0-9]/i.test(nameValue.normalize('NFKD')))
    return fail('Enter a business or website name.');
  const {name}=normalizeSite({name:nameValue});
  const plan=planCustomer({name,accountId:current.cloudflare_account_id,githubOwner:current.github_login,forms:false});
  const files=await extractWebsiteZip(new Uint8Array(await archive.arrayBuffer()));
  const id=crypto.randomUUID();
  const zip=await stageZip(env.ZIP_ARTIFACTS,id,files);
  const time=now();
  const staged=await env.DB.prepare(`INSERT INTO onboarding_launches
    (id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,created_at,updated_at)
    SELECT ?,id_hash,?,cloudflare_account_id,github_login,?,'preview',?,? FROM onboarding_sessions
    WHERE id_hash=? AND authorization_epoch=? AND cloudflare_account_id=? AND cloudflare_token_ct IS NOT NULL
      AND expires_at>? RETURNING id`)
    .bind(id,name,JSON.stringify({...plan,zip,analytics:true}),time,time,current.hash,current.authorization_epoch,current.cloudflare_account_id,time).first();
  if(!staged)return fail('Your connection changed. Review your account selection and upload again.',409);
  recordFunnel(env,'zip_preview',{country:countryFromRequest(request),path:'/upload'});
  return redirect(reviewPath(id));
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
  return {githubAccessToken:githubToken,cloudflareAccessToken:cloudflareToken};
}

const launchIdField=id=>'<input type="hidden" name="id" value="'+escape(id)+'">';
const reviewPath=id=>'/review?id='+encodeURIComponent(id);
// Visitor insights are on by default. The owner can switch them off (or back on) before approving;
// the choice is part of plan_json, which the approval digest covers. Reapprovals keep the job's plan.
async function setReviewAnalytics(request,env,current){
  await limitAttempts(request,env);
  const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
  const id=form.get('id'),value=form.get('analytics');
  if(!isLaunchId(id)||!['true','false'].includes(value))return fail('Choose whether to turn visitor insights on.');
  const item=await getLaunch(env,current,id);
  if(!item||item.status!=='preview'||item.job_id||item.legacy_receipt_id)return fail('This launch can no longer be changed.',409);
  const plan=JSON.parse(item.plan_json);
  const changed=await env.DB.prepare(`UPDATE onboarding_launches SET plan_json=?,updated_at=?
    WHERE id=? AND session_hash=? AND status='preview' AND job_id IS NULL AND legacy_receipt_id IS NULL AND plan_json=?`)
    .bind(JSON.stringify({...plan,analytics:value==='true'}),now(),id,current.hash,item.plan_json).run();
  if(!changed.meta?.changes)return fail('This launch can no longer be changed.',409);
  return redirect(reviewPath(id));
}
const receiptOwner=(current,time)=>({
  githubUserId:current.github_user_id,cloudflareAccountId:current.cloudflare_account_id,time
});

async function launchHistory(env,current){
  if(!current?.cloudflare_account_id)return fail('Connect GitHub and choose your Cloudflare account before viewing your launches.',401);
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
    const action=item.can_restore?button('/restore','Review and continue this launch',current.csrf,launchIdField(item.id)):'';
    const deletion=item.can_delete?button('/delete-launch-history','Remove from this list',current.csrf,launchIdField(item.id)):'';
    const update=item.can_edit?
      '<p><a href="/site-update?id='+encodeURIComponent(item.id)+'">Update this website</a></p>':'';
    const imported=Number(item.uploaded_zip)===1&&item.display_status==='live'?
      '<p><a href="/imported-edit?id='+encodeURIComponent(item.id)+'">Edit imported website</a></p>':'';
    const diagnostic=item.error_code?`<p>Last result code: <code>${escape(item.error_code)}</code> (share this if you need help)</p>`:'';
    const pagesHelp=isPagesAccessError(item.error_code)?'<p>'+pagesAccessLink+' to continue this launch.</p>':'';
    return `<section><h2>${escape(item.customer_name)}</h2><p>Status: ${escape(item.display_status)}</p>${diagnostic}${pagesHelp}${live}${update}${imported}${action}${deletion}</section>`;
  }).join('');
  return view('Your launches',
    '<div class="lo-page"><header class="lo-hero"><h1>Your launches</h1>'+
    '<p>Rows stay for 30 days after first approval. Live sites and private files stay in your accounts even if a row drops off.</p></header>'+
    (cards||'<p>No launches yet for this GitHub and Cloudflare pair.</p>')+
    '<p class="tk-actions"><a class="btn-secondary btn" href="/toolkit">Website toolkit</a> '+
    '<a class="btn-secondary btn" href="/">Back to setup</a></p></div>',
    200,null,{wide:true,omitTitle:true});
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
      a.session_hash AS authorizing_session, c.mode AS approved_pages_mode,
      CASE WHEN a.pages_access_id IS NULL THEN a.authorization_epoch ELSE c.authorization_epoch END AS approved_epoch
    FROM onboarding_launches p
    LEFT JOIN onboarding_launch_jobs j ON j.id=p.job_id AND j.github_user_id=?
      AND j.cloudflare_account_id=p.cloudflare_account_id AND j.expires_at>?
    LEFT JOIN onboarding_launch_job_sessions a ON a.job_id=j.id
    LEFT JOIN onboarding_pages_access c ON c.session_hash=a.session_hash AND c.access_id=a.pages_access_id
      AND c.account_id=j.cloudflare_account_id AND c.expires_at>?
    WHERE p.id=? AND p.session_hash=? AND p.cloudflare_account_id=? AND lower(p.github_login)=lower(?)`)
    .bind(current.github_user_id,time,time,id,current.hash,current.cloudflare_account_id,current.github_login).first();
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
  const {html,zip}=await itemSnapshot(item,current);
  if(zip){
    if(!zipPreviewConfigured(env))return fail('Website ZIP previews are unavailable.',503);
    const stage=item.job_id?'approved':'draft';
    await readZipManifest(env.ZIP_ARTIFACTS,zip,stage);
    const [bundled,interactive]=await Promise.all([
      createZipPreview(env,zip,stage,current.expires_at),
      createZipPreview(env,zip,stage,current.expires_at,{externalAssets:true})
    ]);
    return view('Open private website preview',`<p>View the uploaded pages and bundled assets. Scripts and external assets are blocked in the private preview.</p>
      <form action="${escape(bundled.origin)}/_open" method="POST"><input name="ticket" type="hidden" value="${escape(bundled.ticket)}">
      <button type="submit">Open private preview</button></form>
      <form action="${escape(interactive.origin)}/_open" method="POST"><input name="ticket" type="hidden" value="${escape(interactive.ticket)}">
      <p>Use the interactive preview for a site that needs JavaScript or external fonts, styles, or images. Scripts can read your preview files and send them to third parties.</p>
      <label><input type="checkbox" name="externalAssets" value="true" required> I trust these scripts and external resources</label>
      <button type="submit">Open interactive preview</button></form>`,200,{
      ...textHeaders,'referrer-policy':'origin',
      'content-security-policy':textHeaders['content-security-policy'].replace("form-action 'self'",`form-action ${bundled.origin} ${interactive.origin}`)
    });
  }
  return new Response(html,{status:200,headers:{
    'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
    'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }});
}

async function review(env,current,id){
  const item=await getLaunch(env,current,id);
  if(!item)return fail('This launch request is not accessible.',404);
  const {slug,digest,zip}=await itemSnapshot(item,current);
  const website='https://esp-'+slug+'-site.pages.dev';
  const pagesAccess=item.status==='preview'?await getPagesAccess(env,current):null;
  const verifyExisting=pagesAccess?.mode==='read';
  let pagesAppInstalled=false;
  try{
    const githubToken=await getFreshAccessToken({env,session:current,provider:'github'});
    const installations=await listUserGithubAppInstallations({accessToken:githubToken});
    pagesAppInstalled=githubAppInstalledOnUser({
      installations,appSlug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,githubLogin:current.github_login
    });
  }catch{pagesAppInstalled=false;}
  const statusLabel={
    preview:'Ready for your approval',
    queued:'Creating your site',
    pending_deployment:'Publishing your site',
    live:'Live and checked',
    failed:'Needs attention',
    needs_reauthorization:'Reconnect required'
  };
  const analyticsOn=JSON.parse(item.plan_json).analytics===true;
  const pagesAppHint=pagesAppInstalled?'':
    `<div class="lo-callout lo-callout-warn" role="status"><p class="eyebrow"><span class="lo-badge">Required</span></p>`+
    `<p><strong>Install Cloudflare's Workers &amp; Pages GitHub app</strong> with access to that private folder. Without it, Pages cannot publish.</p>`+
    `<p class="tk-actions"><a class="btn" href="${escape(githubAppInstallUrl(CLOUDFLARE_WORKERS_PAGES_APP_SLUG))}">Install Workers &amp; Pages app</a> `+
    `<a class="btn-secondary btn" href="https://github.com/settings/installations">Review GitHub app installs</a></p></div>`;
  const details=`<p><strong>Website name:</strong> ${escape(item.customer_name)}</p>`+
    `<p><strong>GitHub account:</strong> ${escape(item.github_login)}</p>`+
    `<p><strong>Private files folder:</strong> <code>${escape('esp-'+slug)}</code> (only you can see this on GitHub)</p>`+
    `<p><strong>Public website address:</strong> ${escape(website)}</p>`+
    `<p><strong>Visitor insights:</strong> ${analyticsOn?'On. Cloudflare Web Analytics counts visits and page speed in your own Cloudflare account. It uses no cookies and collects no personal data from visitors.':'Off.'}</p>`+
    (verifyExisting
      ? '<p>With your approval, Launch &amp; Own will check the existing Pages project and verify that it published the exact version you reviewed.</p>'
      : '<p>If you approve, Launch &amp; Own will create that private folder, publish this exact preview to your Cloudflare account, and retry if a step needs another pass while you stay signed in. Later edits to the live branch can update the public site.</p>')+
    pagesAppHint;
  const previewLink='<p><a href="/site-preview?id='+encodeURIComponent(item.id)+'" target="_blank" rel="noopener">Open the exact preview</a> (new tab)</p>';
  let status=item.status;
  let controls='';
  let output='';
  let fileList='';
  if(status==='preview'){
    if(zip){
      const stage=item.job_id?'approved':'draft';
      const manifest=await readZipManifest(env.ZIP_ARTIFACTS,zip,stage);
      let report='';
      try{
        report=importReportMarkup(await inspectSite(await loadZipFiles(env.ZIP_ARTIFACTS,zip,stage)));
      }catch(error){
        if(!(error instanceof TypeError))throw error;
        report='<p>The compatibility check could not be shown for this upload.</p>';
      }
      fileList=report+`<details><summary>Files included in this launch</summary><ul>${manifest.map(file=>`<li><code>${escape(file.path)}</code></li>`).join('')}</ul></details>`;
    }
    if(verifyExisting&&!item.expected_commit_sha){
      output='<p>This launch needs its private GitHub files first. '+pagesAccessLink+' with Pages Edit to create them and launch.</p>';
    }else{
      const accessField=pagesAccess?'<input type="hidden" name="pagesAccessId" value="'+escape(pagesAccess.access_id)+'">':'';
      const analyticsToggle=item.job_id||item.legacy_receipt_id?'':button('/review-analytics',analyticsOn?'Turn off visitor insights':'Turn on visitor insights',current.csrf,
        launchIdField(id)+'<input type="hidden" name="analytics" value="'+(analyticsOn?'false':'true')+'">');
      controls=analyticsToggle+button('/approve',verifyExisting?'Approve and verify existing project':'Approve and create website',current.csrf,
        launchIdField(id)+accessField+'<input type="hidden" name="digest" value="'+escape(digest)+'">');
    }
  }else{
    const bound=item.authorizing_session===current.hash&&item.approved_epoch===current.authorization_epoch;
    status=item.job_status??'needs_reauthorization';
    if(!bound&&['queued','pending_deployment'].includes(status))status='needs_reauthorization';
    if(status==='queued'){
      output=item.approved_pages_mode==='read'
        ?'<p>We are checking the Pages project you created in Cloudflare.</p>'
        :'<p>We are creating your private files and public site. Refresh this page for the latest status.</p>';
      controls=button('/launch','Continue launch',current.csrf,launchIdField(id));
    }
    if(status==='pending_deployment'){
      output=item.approved_pages_mode==='read'
        ?'<p>Waiting for the approved production version. Check the deployment in your Cloudflare dashboard and return here to verify it.</p>'
        :'<p>Cloudflare is publishing the version you approved. This often finishes in a few minutes.</p>';
      controls=button('/verify','Check if it is live',current.csrf,launchIdField(id));
    }
    if(['failed','needs_reauthorization'].includes(status)){
      output='<p>This launch paused. <a href="/history">Open your launches</a> to reconnect and continue when you are ready.</p>';
      if(isPagesAccessError(item.job_error))
        output+='<p role="alert">The account connection and Pages permission are separate. '+pagesAccessLink+' to continue.</p>';
      if(item.job_error==='cloudflare_pages_dashboard_setup_required')
        output+=`<p>In your <a href="https://dash.cloudflare.com/${escape(current.cloudflare_account_id)}/workers-and-pages" rel="noreferrer">Cloudflare dashboard</a>,
          create <code>${escape('esp-'+slug+'-site')}</code> from the private GitHub repository listed above, with <code>public</code> as the output directory and an empty build command. Then return to Your launches to verify it.</p>`;
    }
    if(item.job_error)output+=`<p>Last result code: <code>${escape(item.job_error)}</code></p>`;
    if(item.attempts>0&&['queued','pending_deployment'].includes(status)&&item.next_attempt_at>now()){
      const timestamp=new Date(item.next_attempt_at*1000).toISOString();
      output+=`<p>Tries so far: ${escape(item.attempts)}. Next try after <time datetime="${timestamp}">${timestamp}</time>.</p>`;
    }
    if(status==='live')output=`<p class="pill">Your public website is live and matches what you approved</p><p><a href="${escape(website)}">${escape(website)}</a></p><p>Checked version: <code>${escape(item.expected_commit_sha)}</code></p>`;
  }
  const source=zip?`<p>Uploaded website · ${zip.fileCount} ${zip.fileCount===1?'file':'files'} · ${Math.ceil(zip.totalBytes/1024)} KB</p>`:'';
  const shown=statusLabel[status]||status;
  return view('Review your website',`${source}${details}<p class="pill">${escape(shown)}</p>${previewLink}${fileList}${output}${controls}<p><a href="/">Back to setup</a></p>`,200,textHeaders,
    {step:status==='preview'?'preview':'launch',stepComplete:status==='live'});
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
  const pagesAccess=await getPagesAccess(env,current);
  const pagesAccessId=pagesAccess?.access_id??null;
  if(data.getAll('pagesAccessId').length>1||data.get('pagesAccessId')!==pagesAccessId)
    return fail('Pages access changed. Open the launch review again.',409);
  if(pagesAccess?.mode==='read'&&!item.expected_commit_sha)
    return fail('Connect Pages Edit access before approving creation of the private files and site.',403);
  if(snapshot.zip){
    if(!zipPreviewConfigured(env))return fail('Website ZIP launches are unavailable.',503);
    await retainZip(env.ZIP_ARTIFACTS,snapshot.zip);
  }
  const time=now();
  const receipt=item.legacy_receipt_id&&!item.job_id
    ?await getOwnedReceipt(env,{id:item.legacy_receipt_id,...receiptOwner(current,time)}):null;
  if(item.legacy_receipt_id&&!item.job_id&&!receipt)throw Error('This history entry expired');
  if(!await approveJob(env,{preview:item,session:current,snapshot,receipt,time,pagesAccessId}))
    return fail('This launch changed or its target already has an approved launch. Check your launches.',409);
  recordFunnel(env,'approve',{country:countryFromRequest(request),path:'/approve'});
  queueAttempt(context,env,snapshot.id,current.hash);
  return redirect(reviewPath(item.id));
}

async function runDueStep(request,env,current,context,status){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  const item=await getLaunch(env,current,data.get('id'));
  if(item?.status!=='approved'||item.authorizing_session!==current.hash||
      item.approved_epoch!==current.authorization_epoch)throw Error('This launch step is not authorized');
  // The approval's own run often advances the job first; show its current state instead of an error.
  if(item.job_status!==status)return redirect(reviewPath(item.id));
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
const siteUpdates=createSiteUpdateRoutes({view,fail,button,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now});
const siteFiles=createSiteFilesRoutes({view,fail,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now});
const importedEdits=createImportedEditRoutes({view,fail,button,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now});
const siteOptions=createSiteOptionsRoutes({view,fail,button,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now,
  renderFormsTurnOn,readFormsChoices,finishOwnerOption,formsConsent:()=>formsConsentPage(view,'Turning on your contact form')});
const assistantSetup=createAssistantSetupRoutes({view,fail,escape,button,assertCsrf,formData,now,redirect});
const OPTION_ACTIVATION_HINT={
  provider_source_sha_changed:'GitHub main has a new commit since this launch was verified. Reopen the launch review and run verify again, or merge the site update you started, then turn this on.',
  provider_permission_required:'Cloudflare rejected the change. Disconnect and reconnect Cloudflare, allow Pages and account access, then try again.',
  provider_reauthentication_required:'Your Cloudflare or GitHub session expired. Reconnect both accounts and try again.',
  provider_operation_failed:'Cloudflare could not attach this hostname (wrong account, zone not on Cloudflare, or hostname already in use). Check the domain in your Cloudflare dashboard.',
  separate_execution_approval_required:'This turn-on step lost its safety lock. Reopen site options and try Turn on again.',
  approval_already_claimed_or_changed:'Another turn-on is already in progress or your stored request changed. Refresh site options and try again.',
  applied_domain_row_required:'Turn on custom domain first and wait until Pages shows it active before email forwarding.',
  domain_not_active_on_owned_pages:'Custom domain must be active on your Pages project before email forwarding.',
  email_hostname_mx_not_ready:'Email Routing needs the exact-host MX records Cloudflare documents for this hostname before forwarding can be added.',
  verified_existing_destination_required:'Forward to a mailbox Cloudflare has already verified in your account.'
};
function failOptionActivation(error){
  if(error instanceof OptionExecutionDisabled)
    return fail('This stored request cannot be activated right now. Reopen your site options.',403);
  if(error instanceof FormsConsentRequired)return formsConsentPage(view,'Setting up your contact form');
  const code=error?.code;
  if(code&&OPTION_ACTIVATION_HINT[code])
    return fail(OPTION_ACTIVATION_HINT[code]+' Code '+code+'.',400);
  if(error instanceof ToolkitApprovalExecutionError||error instanceof ExtensionProviderError)
    return fail('This optional feature could not be turned on. Reconnect your accounts or contact support with code '+
      (code||'activation_denied')+'.',400);
  if(error instanceof ProviderRequestError)
    return fail(error.authorizationLost
      ?'GitHub or Cloudflare authorization expired. Reconnect both accounts and try again.'
      :'GitHub or Cloudflare is temporarily unavailable. Wait a moment and try again.',error.authorizationLost?401:503);
  const msg=error?.message||'';
  if(msg==='Rate limit reached')return fail('Too many attempts. Wait a minute and try again.',429);
  if(/authorization|reconnect|Account/i.test(msg))
    return fail('Reconnect GitHub and Cloudflare, then try again.',401);
  return null;
}
function renderOptionExecutionResult(result){
  if(result.kind==='forms')return view('Contact form setup',
    '<p>Your form service is set up in your own Cloudflare account: spam protection, a private database for messages, and a small Worker that receives them.</p>'+
    '<p>Next, connect your site\'s contact form. You review the exact change and merge it yourself.</p>'+
    (isLaunchId(result.jobId)?'<p><a href="/form-connect?id='+encodeURIComponent(result.jobId)+'">Connect your contact form</a></p>':'')+
    '<p>Worker <code>'+escape(result.workerReview.scriptName)+'</code></p>'+
    '<p>Code SHA-256 <code>'+escape(result.workerReview.moduleSha256)+'</code></p>'+
    '<p><a href="/toolkit">Back to toolkit</a></p>');
  if(result.kind==='analytics')return view('Visitor insights',
    '<p>Visitor insights are turned on for <code>'+escape(result.hostname)+'</code> in your Cloudflare account.</p>'+
    '<p>Cloudflare adds the small, cookie-free analytics script the next time your site is published, for example after your next approved change. Visits appear under <strong>Web Analytics</strong> in your Cloudflare dashboard.</p>'+
    '<p><a href="/toolkit">Back to toolkit</a></p>');
  const label=result.kind==='domain'
    ?result.status==='attached_active'
      ?'The custom hostname is active on your Pages project.'
      :'The custom hostname is attached to Pages; DNS and TLS may still need manual setup.'
    :'An Email Routing alias was recorded for the previously verified forwarding mailbox.';
  return view('Optional feature activation', '<p>'+escape(label)+'</p>'+
    '<p><a href="/toolkit">Back to toolkit</a></p>');
}
async function runStoredOptionExecution(env,current,executionId){
  try {
    return await executeOwnedStoredOption(env,current,executionId);
  }catch(error){
    if(error instanceof OptionExecutionDisabled)
      throw error;
    throw error;
  }
}
async function applyApprovedOption(request,env,current){
  await limitAttempts(request,env);
  const data=await formData(request);
  assertCsrf(request,data,current,baseUrl(env));
  if(data.getAll('id').length!==1 || data.size!==2)
    return fail('Open the approved option from your existing toolkit.',400);
  let result;
  try {
    result=await runStoredOptionExecution(env,current,data.get('id'));
  }catch(error){
    const page=failOptionActivation(error);
    if(page)return page;
    if(error instanceof OptionExecutionDisabled)
      return fail('That option has no currently authorized activation grant.',403);
    throw error;
  }
  return renderOptionExecutionResult(result);
}
const FORMS_TURN_ON_REASON={
  cost_owner_approval_required:'confirm the cost limits.',privacy_owner_approval_required:'confirm the privacy responsibilities.',
  retention_days_out_of_range:'choose a retention between 1 and 365 days.',max_submissions_per_day_out_of_range:'choose between 1 and 1,000 messages a day.',
  max_body_bytes_out_of_range:'choose a message size between 256 bytes and 64 KB.',forms_request_required:'save the contact form request first.',
  cost_privacy_row_conflict:'an operator already approved different limits for this form.'
};
/** Owner forms turn-on review (owner decision 2026-11-26): what is created, what is stored, limits and cost, two explicit confirmations. */
async function formsTurnOnPage(env,current,approvalId){
  const reviewed=await readOwnedStoredOptionApproval(env,current,approvalId);
  if(!reviewed||reviewed.kind!=='forms'||!ownerSelfActivationEnabled(env,'forms'))
    return fail('Save the contact form request in your site options first.',404);
  if(current.cloudflare_forms_grant!==1)return formsConsentPage(view,'Turning on your contact form');
  return renderFormsTurnOn(current,reviewed.currentSite,{action:'/site-options-activate',fields:
    '<input type="hidden" name="approvalId" value="'+escape(reviewed.id)+'">'});
}
function renderFormsTurnOn(current,site,{action,fields,ownerEmail}){
  const d=OWNER_FORMS_DEFAULTS;
  return view('Turn on your contact form',
    '<p>This sets up a contact form service in <strong>your own Cloudflare account</strong> for <code>'+escape(site.pagesProjectName)+'</code>.</p>'+
    (ownerEmail?'<p>Owner email <strong>'+escape(ownerEmail)+'</strong></p>':'')+
    '<h2>What gets created</h2><ul><li>A Turnstile spam-protection widget.</li><li>A private D1 database that stores the messages visitors send.</li>'+
    '<li>A small Worker named <code>'+escape(site.pagesProjectName.replace(/-site$/,''))+'-site-form</code> that receives them, with a daily clean-up.</li></ul>'+
    '<h2>What it stores</h2><p>What visitors type into your form, such as names, email addresses and messages. That is <strong>personal data</strong>: you are responsible for it, and your site should say how you use it. Launch &amp; Own keeps no copy.</p>'+
    '<h2>Cost</h2><p>On Cloudflare\'s free plan this fits in the free limits for Workers (100,000 requests a day) and D1. If a daily limit is reached, the form stops until the next day; you are not charged. On a paid plan, Cloudflare bills usage above the included amounts.</p>'+
    '<form action="'+escape(action)+'" method="POST"><input type="hidden" name="csrf" value="'+escape(current.csrf)+'">'+fields+
      '<label for="ft-retention">Delete messages after (days)</label><input id="ft-retention" name="retentionDays" type="number" min="1" max="365" required value="'+d.retentionDays+'">'+
      '<label for="ft-max">Most messages accepted per day</label><input id="ft-max" name="maxSubmissionsPerDay" type="number" min="1" max="1000" required value="'+d.maxSubmissionsPerDay+'">'+
      '<label for="ft-size">Largest message size (bytes)</label><input id="ft-size" name="maxBodyBytes" type="number" min="256" max="65536" required value="'+d.maxBodyBytes+'">'+
      '<label><input type="checkbox" name="costApproved" value="true" required> I understand the limits and that any Cloudflare charges are billed to my account.</label>'+
      '<label><input type="checkbox" name="privacyApproved" value="true" required> I am responsible for the messages visitors send, and they are deleted after the number of days above.</label>'+
      '<button type="submit">Turn on contact form</button></form>'+
    '<p><a href="/site-options?id='+encodeURIComponent(site.jobId)+'">Back to optional features</a></p>');
}
function readFormsChoices(data){
  const int=name=>/^\d{1,6}$/.test(data.get(name)||'')?Number(data.get(name)):NaN;
  return {retentionDays:int('retentionDays'),maxSubmissionsPerDay:int('maxSubmissionsPerDay'),maxBodyBytes:int('maxBodyBytes'),
    costApproved:data.get('costApproved')==='true',privacyApproved:data.get('privacyApproved')==='true'};
}
async function activateOwnerOption(request,env,current){
  await limitAttempts(request,env);
  const data=await formData(request);
  assertCsrf(request,data,current,baseUrl(env));
  // Forms turn-on carries the owner's cost/privacy choices; domain/email carry only the approval ID.
  const formsTurnOn=data.has('retentionDays');
  if(data.getAll('approvalId').length!==1 || data.size!==(formsTurnOn?7:2))
    return fail('Open this option from your toolkit.',400);
  try{await assertHistoryAccess(env,current);}catch(error){
    const page=failOptionActivation(error);
    if(page)return page;
    throw error;
  }
  return finishOwnerOption(env,current,data.get('approvalId'),formsTurnOn?readFormsChoices(data):null);
}
async function finishOwnerOption(env,current,approvalId,formsChoices){
  if(formsChoices){
    // Nothing is written until the session holds the separate Cloudflare forms permission.
    if(current.cloudflare_forms_grant!==1)return formsConsentPage(view,'Turning on your contact form');
    const stored=await storeOwnerFormsCostPrivacy(env,current,approvalId,formsChoices);
    if(!stored.ok)return fail('The contact form was not turned on: '+(FORMS_TURN_ON_REASON[stored.reason]||'please review the choices and try again.')+
      ' Code '+(stored.reason||'forms_turn_on_failed')+'.',400);
  }
  const execId=await mintOwnerExecutionGrant(env,current,approvalId);
  if(!execId)
    return fail('This stored request cannot be activated right now. Reopen your site options.',403);
  let result;
  try {
    result=await runStoredOptionExecution(env,current,execId);
  }catch(error){
    const page=failOptionActivation(error);
    if(page)return page;
    throw error;
  }
  return renderOptionExecutionResult(result);
}

// form-action 'self' so Preview can POST to /imported-edit-visual-preview (was 'none', which silently blocked saves).
// style/img/font https: so the edit canvas srcdoc can paint the owner's page (it inherits this CSP).
// Scripts stay locked to the editor; the canvas iframe has no allow-scripts.
// frame-src includes pages.dev for the Preview (eye) viewer and common embeds.
const SITE_EDITOR_CSP = "default-src 'none'; script-src 'self' 'sha256-w/2imsdarei1j5pi6r+IEiosLFkxX04hdaM1u/629po='; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'self'; worker-src 'self'; frame-src 'self' https://*.pages.dev https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

async function siteEditorAsset(request, env, url) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return fail('The page editor is unavailable.', 404);
  const relative = url.pathname.slice('/site-editor'.length);
  if (!relative.startsWith('/') || relative.includes('..') || relative.includes('\\')) return fail('The page editor is unavailable.', 404);
  const assetUrl = new URL(request.url);
  assetUrl.pathname = relative;
  assetUrl.search = '';
  const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', SITE_EDITOR_CSP);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  headers.set('cache-control', 'no-store');
  headers.delete('x-frame-options');
  return new Response(response.body, { status: response.status, headers });
}

async function handleFetch(request,env,context){
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
      // Bridge → onboarding sealed status lookup (no browser session involved).
      if(request.method==='POST'&&url.pathname==='/internal/bridge-launch-status')return await bridgeLaunchStatus(request,env,{now});
      configured(env);
      if(url.origin!==baseUrl(env))return fail('This service requires its registered HTTPS origin.',400);
      const current=await session(request,env);
      if(request.method==='GET'){
        if(url.pathname==='/')return await home(env,current,url.searchParams.get('disconnect'),request);
        if(url.pathname==='/connect/github')return await gitHubStart(request,env);
        if(url.pathname==='/oauth/github/callback')return await gitHubCallback(request,env,current);
        if(url.pathname==='/connect/cloudflare')return await cloudflareStart(request,env,current);
        if(url.pathname==='/oauth/cloudflare/callback')return await cloudflareCallback(request,env,current);
        if(url.pathname==='/review'&&url.searchParams.has('draft')&&!url.searchParams.has('id'))
          return await importBridgeDraft(env,current,url.searchParams.get('draft'),{redirect,fail,now});
        if(url.pathname==='/review')return await review(env,current,url.searchParams.get('id'));
        if(url.pathname==='/history')return await launchHistory(env,current);
        if(url.pathname==='/toolkit')return await toolkit(env,current,request);
        if(url.pathname==='/toolkit/source')return await toolkitSource(env,current,request);
        if(url.pathname==='/form-messages')return await formMessages(env,current,url.searchParams.get('id'));
        if(url.pathname==='/site-options-files-turn-on')return await siteFiles.review(env,current,url.searchParams);
        if(url.pathname==='/site-options-forms-turn-on')return await formsTurnOnPage(env,current,url.searchParams.get('approvalId'));
        if(url.pathname===pagesAccessPath)return await pagesAccessPage(env,current);
        if(url.pathname==='/site-preview')return await sitePreview(env,current,url.searchParams.get('id'));
        if(url.pathname==='/agent-link')return await showAgentLink(env,current,url.searchParams.get('challenge_id'),{view,fail,button,escape});
        if(url.pathname==='/site-update')return await siteUpdates.editor(env,current,url.searchParams.get('id'));
        if(url.pathname==='/site-update-review')return await siteUpdates.review(env,current,url.searchParams.get('ticket'));
        if(url.pathname==='/site-update-html')return await siteUpdates.html(env,current,url.searchParams.get('ticket'));
        if(url.pathname==='/site-update-status')return await siteUpdates.status(env,current,url.searchParams.get('ticket'));
        if(url.pathname.startsWith('/site-editor/'))return await siteEditorAsset(request,env,url);
        if(url.pathname.startsWith('/imported-edit-live/'))return await importedEdits.live(env,current,url);
        if(url.pathname==='/imported-edit')return await importedEdits.editor(env,current,url.searchParams.get('id'),url);
        if(url.pathname==='/imported-edit-files')return await importedEdits.projectFiles(env,current,url.searchParams.get('id'));
        if(url.pathname==='/imported-edit-review')return await importedEdits.review(env,current,url.searchParams.get('ticket'));
        if(url.pathname==='/imported-edit-file')return await importedEdits.file(env,current,url);
        if(url.pathname==='/imported-edit-status')return await importedEdits.status(env,current,url.searchParams.get('ticket'));
        if(url.pathname==='/form-connect')return await importedEdits.connectForm(env,current,url.searchParams.get('id'));
        if(url.pathname==='/site-options')return await siteOptions.page(env,current,url.searchParams.get('id'));
        if(url.pathname==='/assistant-setup')return await assistantSetup.page(env,current,request);
      }
      if(request.method==='POST'){
        if(url.pathname==='/agent-link')return await confirmAgentLink(request,env,current,{view,fail,escape},{assertCsrf,formData,now});
        if(url.pathname==='/account')return await selectAccount(request,env,current);
        if(url.pathname===pagesAccessPath)return await setPagesAccess(request,env,current);
        if(url.pathname===pagesAccessPath+'/remove')return await clearPagesAccess(request,env,current);
        if(url.pathname==='/upload')return await uploadZip(request,env,current);
        if(url.pathname==='/preview')return await preview(request,env,current);
        if(url.pathname==='/draft')return await draft(request,env,current);
        if(url.pathname==='/approve')return await approve(request,env,current,context);
        if(url.pathname==='/review-analytics')return await setReviewAnalytics(request,env,current);
        if(url.pathname==='/launch')return await runDueStep(request,env,current,context,'queued');
        if(url.pathname==='/verify')return await runDueStep(request,env,current,context,'pending_deployment');
        if(url.pathname==='/logout')return await logout(request,env,current);
        if(url.pathname==='/restore')return await restoreLaunch(request,env,current);
        if(url.pathname==='/delete-launch-history')return await removeLaunchHistory(request,env,current);
        if(url.pathname==='/site-update-preview')return await siteUpdates.prepare(request,env,current);
        if(url.pathname==='/site-update-approve')return await siteUpdates.approve(request,env,current);
        if(url.pathname==='/imported-edit-preview')return await importedEdits.prepare(request,env,current);
        if(url.pathname==='/imported-edit-visual-preview')return await importedEdits.visualPreview(request,env,current);
        if(url.pathname==='/imported-edit-approve')return await importedEdits.approve(request,env,current);
        if(url.pathname==='/form-connect-approve')return await importedEdits.connectFormApprove(request,env,current);
        if(url.pathname==='/site-options-prepare')return await siteOptions.prepare(request,env,current);
        if(url.pathname==='/site-options-approve')return await siteOptions.approve(request,env,current);
        if(url.pathname==='/site-options-activate')return await activateOwnerOption(request,env,current);
        if(url.pathname==='/site-options-redirects-review')return await siteFiles.reviewRedirects(request,env,current);
        if(url.pathname==='/site-options-files-publish')return await siteFiles.publish(request,env,current);
        if(url.pathname==='/site-options-execute')return await applyApprovedOption(request,env,current);
        // Retired #121 direct-write endpoint: a stored review cannot authorize a provider mutation.
        if(url.pathname==='/site-options-apply')return fail('Reopen site options. A separate operator-approved execution grant is now required.',403);
        if(url.pathname==='/assistant-setup/consent')return await assistantSetup.consent(request,env,current);
        if(url.pathname==='/assistant-setup/create')return await assistantSetup.create(request,env,current);
        if(url.pathname==='/assistant-setup/access')return await assistantSetup.access(request,env,current);
        if(url.pathname==='/assistant-setup/github-app')return await assistantSetup.githubApp(request,env,current);
        if(url.pathname==='/assistant-setup/install')return await assistantSetup.install(request,env,current);
        if(url.pathname==='/assistant-setup/deploy-app')return await assistantSetup.deployApp(request,env,current);
      }
      return fail('Page not found',404);
    }catch(error){
      if(error instanceof WebsiteZipError)return fail(error.message);
      // Never log bearer tokens, OAuth codes, cookie values or request bodies.
      const code=error?.message==='Onboarding account connections are not configured'?'not_configured':'request_rejected';
      console.error(JSON.stringify({event:'onboarding_request_error',code}));
      return fail(code==='not_configured'?'Account connections are being configured.':'This request could not be completed. Refresh and try again.',code==='not_configured'?503:400);
    }
}

export default {
  async fetch(request,env,context){
    const analyticsToken=/^[a-f0-9]{32}$/i.test(env.ONBOARD_WEB_ANALYTICS_TOKEN||'')
      ?env.ONBOARD_WEB_ANALYTICS_TOKEN:'';
    return requestUi.run({analyticsToken},()=>handleFetch(request,env,context));
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
