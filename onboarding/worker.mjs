import {beginGitHubAppOAuth,completeGitHubAppOAuth} from '../pipeline/github-app-oauth.mjs';
import {beginCloudflareOAuth,completeCloudflareOAuth,verifyCloudflareAccount} from '../pipeline/cloudflare-oauth.mjs';
import {planCustomer} from '../pipeline/plan-customer.mjs';
import {applyWebsite} from '../pipeline/provision-site.mjs';
import {verifyWebsite} from '../pipeline/verify-site.mjs';
import {randomToken,sha256,seal,unseal} from './crypto.mjs';

const COOKIE_SESSION='__Host-esp_session';
const COOKIE_LOGIN='__Host-esp_login';
const textHeaders={
  'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'x-frame-options':'DENY','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const now=()=>Math.floor(Date.now()/1000);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookie=(name,value,maxAge)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const redirect=(path,setCookie)=>{
  const headers=new Headers({'location':path,'cache-control':'no-store','referrer-policy':'no-referrer'});
  if(setCookie)headers.append('set-cookie',setCookie);
  return new Response(null,{status:303,headers});
};
const view=(title,body,status=200)=>new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Launch & Own</title><style>
body{font:16px/1.6 system-ui,sans-serif;background:#f6f8fc;color:#15243a;margin:0}main{max-width:680px;margin:5vh auto;padding:32px;background:white;border:1px solid #dfe6ef;border-radius:18px}h1{font-size:30px;margin:0 0 18px}a,button{color:#174ca5}button{padding:10px 16px;background:#174ca5;color:white;border:0;border-radius:8px;cursor:pointer}input,select{padding:10px;width:100%;box-sizing:border-box;margin-bottom:16px;border:1px solid #a1acba;border-radius:6px}label{display:block;font-weight:600}small{color:#455771}.muted{color:#65738a}.pill{display:inline-block;padding:2px 8px;background:#e8f1e9;border-radius:12px}p{overflow-wrap:anywhere}section{border-top:1px solid #e5eaf0;padding-top:14px;margin-top:18px}footer{margin-top:28px;font-size:13px;color:#53657a}</style></head><body><main><h1>${escape(title)}</h1>${body}<footer>Customer-controlled hosting · No paid email service · Beta onboarding</footer></main></body></html>`,{status,headers:textHeaders});
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
  const record=await env.DB.prepare('SELECT id_hash,github_user_id,github_login,github_token_ct,cloudflare_token_ct,cloudflare_account_id,csrf_ct,expires_at FROM onboarding_sessions WHERE id_hash=? AND expires_at>?').bind(hash,now()).first();
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
  const resp=await fetch(url,{headers:{'authorization':'Bearer '+token,'accept':'application/json','x-github-api-version':'2022-11-28'},redirect:'error'});
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
async function gitHubCallback(request,env){
  const url=new URL(request.url);
  if(url.searchParams.has('error'))return fail('GitHub authorization was cancelled. You can try again.');
  const nonce=cookies(request)[COOKIE_LOGIN];
  const verifier=await consumeFlow(env,{provider:'github',binding:nonce,state:url.searchParams.get('state')});
  const token=await completeGitHubAppOAuth({clientId:env.GH_CLIENT_ID,clientSecret:env.GH_CLIENT_SECRET,redirectUri:baseUrl(env)+'/oauth/github/callback',code:url.searchParams.get('code'),receivedState:url.searchParams.get('state'),expectedState:url.searchParams.get('state'),codeVerifier:verifier});
  const user=await apiGet('https://api.github.com/user',token.access_token);
  if(typeof user.login!=='string'||!Number.isSafeInteger(user.id))throw Error('Unable to verify the connected GitHub user');
  const raw=randomToken(),hash=await sha256(raw),csrf=randomToken();
  const ghCipher=await seal(env.TOKEN_ENCRYPTION_KEY,token.access_token,'github:'+hash);
  const csrfCipher=await seal(env.TOKEN_ENCRYPTION_KEY,csrf,'csrf:'+hash);
  await env.DB.prepare('INSERT INTO onboarding_sessions(id_hash,github_user_id,github_login,github_token_ct,csrf_ct,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .bind(hash,user.id,user.login,ghCipher,csrfCipher,now(),now()+3600).run();
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
  const ciphertext=await seal(env.TOKEN_ENCRYPTION_KEY,token.access_token,'cloudflare:'+current.hash);
  await env.DB.prepare('UPDATE onboarding_sessions SET cloudflare_token_ct=?,cloudflare_account_id=NULL WHERE id_hash=? AND expires_at>?')
    .bind(ciphertext,current.hash,now()).run();
  return redirect('/');
}
async function accountOptions(env,current){
  const token=await unseal(env.TOKEN_ENCRYPTION_KEY,current.cloudflare_token_ct,'cloudflare:'+current.hash);
  const url='https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50';
  const response=await fetch(url,{headers:{authorization:'Bearer '+token,accept:'application/json'},redirect:'error'});
  if(!response.ok)throw Error('Unable to list accounts: check the Cloudflare OAuth permissions');
  const data=await response.json();
  if(!data.success||!Array.isArray(data.result))throw Error('Cloudflare did not return a list of accounts');
  return data.result.filter(a=>typeof a.id==='string'&&/^[a-f\d]{32}$/i.test(a.id)).map(a=>({id:a.id,name:String(a.name||a.id)}));
}
async function home(env,current){
  if(!current)return view('Launch your website',`<p><strong>Describe it. Launch it. Own it.</strong></p><p>Build and maintain your own website using your GitHub and Cloudflare accounts.</p><p>Connect GitHub to get started. You approve each launch before any resources are created.</p><p><a href="/connect/github">Connect GitHub</a></p><small>We do not ask for API tokens or passwords.</small>`);
  const connected=!!current.cloudflare_token_ct;
  let accountHtml='';
  if(connected&&!current.cloudflare_account_id){
    try{
      const accounts=await accountOptions(env,current);
      accountHtml=accounts.length?`<section><h2>Choose your Cloudflare account</h2><p>Only the selected account will be used.</p>${button('/account','Select account',current.csrf,`<label for="account">Cloudflare account</label><select id="account" name="accountId" required>${accounts.map(a=>`<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('')}</select>`)}</section>`:'<p>No authorized Cloudflare accounts were found. Check the connection permissions.</p>';
    }catch{accountHtml='<p>Could not list your Cloudflare accounts. Reconnect with the required permissions.</p>';}
  }
  const next=connected&&current.cloudflare_account_id?`<section><h2>Preview your website</h2><p>Website-only beta: contact forms and custom domains will be supported after their isolated security configuration is automated.</p>${button('/preview','Review setup',current.csrf,`<label for="name">Business or website name</label><input id="name" name="name" maxlength="80" required placeholder="e.g. Green Willow Studio">`)}</section>`:'';
  return view('Website setup',`<p class="pill">GitHub connected: ${escape(current.github_login)}</p><p>Cloudflare: ${connected?'Connected':'Not connected'}${current.cloudflare_account_id?' · Account selected':''}</p>${!connected?'<p><a href="/connect/cloudflare">Connect Cloudflare</a></p>':''}${accountHtml}${next}<section>${button('/logout','Disconnect and sign out',current.csrf)}</section>`);
}
async function selectAccount(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(!current.cloudflare_token_ct)throw Error('Connect Cloudflare before selecting an account');
  const accountId=data.get('accountId');
  const token=await unseal(env.TOKEN_ENCRYPTION_KEY,current.cloudflare_token_ct,'cloudflare:'+current.hash);
  await verifyCloudflareAccount({accessToken:token,accountId});
  await env.DB.prepare('UPDATE onboarding_sessions SET cloudflare_account_id=? WHERE id_hash=? AND expires_at>?').bind(accountId,current.hash,now()).run();
  return redirect('/');
}
async function preview(request,env,current){
  await limitAttempts(request,env);
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  if(!current.cloudflare_account_id||!current.cloudflare_token_ct)throw Error('Choose your authorized Cloudflare account first');
  const name=data.get('name');
  if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('Enter a website name no longer than 80 characters');
  const config={name,accountId:current.cloudflare_account_id,githubOwner:current.github_login,forms:false};
  const plan=planCustomer(config);
  const id=crypto.randomUUID(),ts=now();
  await env.DB.prepare('INSERT INTO onboarding_launches(id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id,current.hash,name,current.cloudflare_account_id,current.github_login,JSON.stringify(plan),'preview',ts,ts).run();
  return redirect('/review?id='+encodeURIComponent(id));
}
async function getLaunch(env,current,id){
  if(!current||typeof id!=='string'||!(/^[a-f\d-]{36}$/i.test(id)))return null;
  return await env.DB.prepare('SELECT id,customer_name,github_login,cloudflare_account_id,plan_json,status,provision_result,error_code,updated_at FROM onboarding_launches WHERE id=? AND session_hash=?')
    .bind(id,current.hash).first();
}
async function review(env,current,id){
  const item=await getLaunch(env,current,id);
  if(!item)return fail('This launch request is not accessible.',404);
  const plan=JSON.parse(item.plan_json);
  const details=`<p><strong>Name:</strong> ${escape(item.customer_name)}</p><p><strong>GitHub:</strong> ${escape(item.github_login)}</p><p><strong>Cloudflare:</strong> ${escape(item.cloudflare_account_id)}</p><p><strong>Private repository:</strong> ${escape('esp-'+plan.customer)}</p><p><strong>Public Pages URL:</strong> https://${escape('esp-'+plan.customer+'-site.pages.dev')}</p><p>Approving creates a private GitHub repository and a publicly accessible starter website. No forms, email, domain changes, billing changes, or deletions are included.</p><p>Cloudflare's Workers &amp; Pages GitHub App must have permission to access the new repository. <a href="https://github.com/settings/installations">Review GitHub App access</a>.</p>`;
  const formId=`<input type="hidden" name="id" value="${escape(item.id)}">`;
  const approveForm=item.status==='preview'?button('/approve','Approve and create website',current.csrf,formId):'';
  const retryForm=(item.status==='failed'||(item.status==='provisioning'&&item.updated_at<now()-300))?button('/launch','Retry provisioning safely',current.csrf,formId):'';
  const verifyForm=(item.status==='pending_deployment'||item.status==='live')?button('/verify','Check live deployment',current.csrf,formId):'';
  let output='';
  if(item.provision_result){
    const result=JSON.parse(item.provision_result);
    if(typeof result.website==='string'&&result.website.startsWith('https://'))output=`<p>Website: <a href="${escape(result.website)}">${escape(result.website)}</a></p><p>Repository: <a href="${escape(result.repository)}">${escape(result.repository)}</a></p>`;
  }
  if(item.status==='pending_deployment')output+='<p>Cloudflare is building your website. It is not marked live until production verification succeeds.</p>';
  if(item.status==='failed')output+='<p>Setup stopped. Check account permissions, especially the Cloudflare Workers &amp; Pages GitHub App installation, then retry. Existing resources are preserved.</p>';
  if(item.status==='live')output+='<p class="pill">Public website deployment verified</p>';
  return view('Review website launch',`${details}<p class="pill">Status: ${escape(item.status)}</p>${output}${approveForm}${retryForm}${verifyForm}<p><a href="/">Back to setup</a></p>`);
}
async function launchRequest(env,current,id){
  const item=await getLaunch(env,current,id);
  if(!item||!['approved','failed','provisioning'].includes(item.status))throw Error('This website is not approved for provisioning');
  if(item.status==='provisioning'&&item.updated_at>=now()-300)throw Error('Provisioning is already in progress');
  if(current.cloudflare_account_id!==item.cloudflare_account_id||current.github_login.toLowerCase()!==item.github_login.toLowerCase())throw Error('Authorized account changed since approval');
  if(!current.cloudflare_token_ct)throw Error('Cloudflare account authorization is missing');
  const fresh=await env.DB.prepare("UPDATE onboarding_launches SET status='provisioning',updated_at=? WHERE id=? AND session_hash=? AND (status IN ('approved','failed') OR (status='provisioning' AND updated_at<?)) RETURNING id")
    .bind(now(),id,current.hash,now()-300).first();
  if(!fresh)throw Error('Provisioning is already in progress or no longer authorized');
  try{
    const githubToken=await unseal(env.TOKEN_ENCRYPTION_KEY,current.github_token_ct,'github:'+current.hash);
    const cloudflareToken=await unseal(env.TOKEN_ENCRYPTION_KEY,current.cloudflare_token_ct,'cloudflare:'+current.hash);
    const config={name:item.customer_name,githubOwner:item.github_login,accountId:item.cloudflare_account_id,forms:false};
    const result=await applyWebsite(config,{githubToken,cloudflareToken});
    await env.DB.prepare("UPDATE onboarding_launches SET status='pending_deployment',provision_result=?,error_code=NULL,updated_at=? WHERE id=? AND session_hash=?")
      .bind(JSON.stringify(result),now(),id,current.hash).run();
  }catch{
    await env.DB.prepare("UPDATE onboarding_launches SET status='failed',error_code='provision_failed',updated_at=? WHERE id=? AND session_hash=?")
      .bind(now(),id,current.hash).run();
  }
  return redirect('/review?id='+encodeURIComponent(id));
}
async function approve(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  const id=data.get('id');const item=await getLaunch(env,current,id);
  if(!item||item.status!=='preview')throw Error('This launch request was already approved or is no longer accessible');
  const updated=await env.DB.prepare('UPDATE onboarding_launches SET status=?,approved_at=?,updated_at=? WHERE id=? AND session_hash=? AND status=? RETURNING id')
    .bind('approved',now(),now(),id,current.hash,'preview').first();
  if(!updated)throw Error('This launch request was already approved');
  return await launchRequest(env,current,id);
}
async function launch(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  return await launchRequest(env,current,data.get('id'));
}
async function verify(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  const id=data.get('id'),item=await getLaunch(env,current,id);
  if(!item||!['pending_deployment','live'].includes(item.status))throw Error('There is no deployment to verify');
  if(item.cloudflare_account_id!==current.cloudflare_account_id)throw Error('Account changed since approval');
  if(!current.cloudflare_token_ct)throw Error('Reconnect your Cloudflare account');
  const token=await unseal(env.TOKEN_ENCRYPTION_KEY,current.cloudflare_token_ct,'cloudflare:'+current.hash);
  const provisioned=item.provision_result?JSON.parse(item.provision_result):null;
  const expectedCommitSha=provisioned?.headCommitSha;
  if(typeof expectedCommitSha!=='string'||!/^[a-f0-9]{40}$/i.test(expectedCommitSha))
    throw Error('The approved source revision is missing. Deployment cannot be confirmed safely.');
  const result=await verifyWebsite({name:item.customer_name,accountId:item.cloudflare_account_id,githubOwner:item.github_login,forms:false},{cloudflareToken:token,expectedCommitSha});
  if(result.status==='live')await env.DB.prepare("UPDATE onboarding_launches SET status='live',updated_at=? WHERE id=? AND session_hash=? AND status IN ('pending_deployment','live')").bind(now(),id,current.hash).run();
  return redirect('/review?id='+encodeURIComponent(id));
}
async function logout(request,env,current){
  const data=await formData(request);assertCsrf(request,data,current,baseUrl(env));
  await env.DB.prepare('DELETE FROM onboarding_sessions WHERE id_hash=?').bind(current.hash).run();
  const result=redirect('/');result.headers.append('set-cookie',cookie(COOKIE_SESSION,'',0));
  return result;
}
export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url);
      if(url.pathname==='/health'&&request.method==='GET')return Response.json({ok:true,configured:!!(env.DB&&env.ONBOARDING_LIMITER&&env.ONBOARDING_ORIGIN&&env.TOKEN_ENCRYPTION_KEY&&env.GH_CLIENT_ID&&env.GH_CLIENT_SECRET&&env.CF_CLIENT_ID&&env.CF_CLIENT_SECRET&&env.CF_SCOPES)},{headers:{'cache-control':'no-store'}});
      configured(env);
      if(url.origin!==baseUrl(env))return fail('This service requires its registered HTTPS origin.',400);
      const current=await session(request,env);
      if(request.method==='GET'){
        if(url.pathname==='/')return await home(env,current);
        if(url.pathname==='/connect/github')return await gitHubStart(request,env);
        if(url.pathname==='/oauth/github/callback')return await gitHubCallback(request,env);
        if(url.pathname==='/connect/cloudflare')return await cloudflareStart(request,env,current);
        if(url.pathname==='/oauth/cloudflare/callback')return await cloudflareCallback(request,env,current);
        if(url.pathname==='/review')return await review(env,current,url.searchParams.get('id'));
      }
      if(request.method==='POST'){
        if(url.pathname==='/account')return await selectAccount(request,env,current);
        if(url.pathname==='/preview')return await preview(request,env,current);
        if(url.pathname==='/approve')return await approve(request,env,current);
        if(url.pathname==='/launch')return await launch(request,env,current);
        if(url.pathname==='/verify')return await verify(request,env,current);
        if(url.pathname==='/logout')return await logout(request,env,current);
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
    // Remove expired authentication and temporary sessions without touching customer sites.
    const expired=now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM onboarding_flows WHERE expires_at<?').bind(expired),
      env.DB.prepare('DELETE FROM onboarding_sessions WHERE expires_at<?').bind(expired)
    ]);
  }
};