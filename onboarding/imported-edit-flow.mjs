// Hosted imported-site edits. The owner session, CSRF check, and launch record
// decide who can ask. Model output is not accepted on these routes.
import {gitBlobSha} from '../imported/bytes.mjs';
import {bindApproval,newApprovalId} from '../imported/approval.mjs';
import {d1ApprovalStore} from '../imported/approval-store.mjs';
import {ImportedEditError} from '../imported/errors.mjs';
import {inspectSite} from '../imported/intelligence.mjs';
import {parseModelOutput,validateEdits} from '../imported/edits.mjs';
import {artifactDigest,isolatePreview,previewResponse} from '../imported/preview.mjs';
import {proposeImportedPullRequest,readImportedPullRequest} from '../imported/pull-request.mjs';
import {readCurrentRevision} from '../imported/revision.mjs';
import {verifyPublishedRevision} from '../imported/verify-published.mjs';
import {getOwnedJob,hasCurrentOwnerSession,isLaunchId} from './launch-jobs.mjs';
import {seal,unseal} from './crypto.mjs';
import {isZipArtifact,stageZip} from './zip-artifacts.mjs';
import {createZipPreview,zipPreviewConfigured} from './zip-preview-access.mjs';
import {readToolkitPreviewStatus} from './toolkit-preview.mjs';
import {editReviewMarkup} from './edit-review.mjs';

class PreviewBuildPolicyUnavailable extends Error {}

const SHA=/^[a-f0-9]{40}$/i;
const DIGEST=/^[a-f0-9]{64}$/i;
const REVIEW_LIFETIME=15*60;
const STATUS_LIFETIME=30*24*60*60;
const KINDS=new Set(['text','link','business_info','css_color']);

const SAFE={
  'ambiguous_match':'That text appears more than once. Preview a unique phrase instead.',
  'no_match':'That text was not found once in the file. Preview the current text exactly.',
  'not_found_anywhere':'We could not find that text on any page you can edit. Copy it exactly as it appears on your site.',
  'context_not_allowed':'That replacement is not an allowed text, link, business-info, or custom-property color edit.',
  'overlapping_edits':'Those edits overlap. Preview one unique phrase at a time.',
  'kind_not_allowed':'That change is not available for this file. JavaScript, dependencies, and hosting configuration stay unchanged.',
  'stale_base':'GitHub main changed. Start a fresh preview.',
  'approval_mismatch':'The preview no longer matches the approved files. Start a fresh preview.',
  'approval_consumed':'This approval was already used. Start a fresh preview.',
  'expired':'This preview expired. Start a fresh preview.',
  'approval-digest-mismatch':'The preview no longer matches the approved files. Start a fresh preview.',
  'repository-mismatch':'The connected GitHub account does not own this private site.',
  'revision-unreadable':'The current website files could not be read. No pull request was opened.',
  'github-read-failed':'The current website files could not be read. No pull request was opened.',
  'source_project':'This upload is an unbuilt project or hosting configuration, so it was not edited.',
  'unsupported':'This upload has no editable index.html, so it was not edited.',
  'compiled_bundle':'Compiled and minified bundles are not edited from this page.',
  'credentials_revoked':'GitHub access changed. Reconnect GitHub, then start a fresh preview.',
  'limit_exceeded':'That change is over the limit for this page.',
  'invalid_output':'That edit was not a valid text, link, business-info, or color change.',
  'missing_local_dependency':'That change points at a file the site does not have.',
  'unrelated_change':'That change touched a file outside the edit. No pull request was opened.'
};
const KIND_LABEL={
  text:'visible text',
  link:'link address',
  business_info:'business email or phone',
  css_color:'custom property color'
};
const REASON={
  source_project:SAFE.source_project,
  bare_import:'A script imports a package a browser cannot load.',
  unsupported_file_type:'This upload includes a file type this page does not accept.',
  minified_js_bundle:SAFE.compiled_bundle,
  config_file:'Dependency and hosting files stay unchanged.',
  missing_local_dependency:'A page points at a file the upload does not contain.'
};

export function createImportedEditRoutes({view,fail,button,escape,formData,assertCsrf,baseUrl,limitAttempts,assertHistoryAccess,now}){
  function fencedFetch(env,current){
    return async(url,options={})=>{
      if(!await hasCurrentOwnerSession(env,current,now()))
        throw Error('Connected account authorization changed during update');
      return await fetch(url,{...options,signal:options.signal??AbortSignal.timeout(8000)});
    };
  }
  function guardedFetch(env,current,job,cloudflareAccessToken){
    const fetchFn=fencedFetch(env,current);
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
    return async(url,options={})=>{
      if((options.method??'GET')!=='GET'){
        const preview=await readToolkitPreviewStatus(previewRequest);
        if(preview.state!=='disabled')throw new PreviewBuildPolicyUnavailable();
      }
      return await fetchFn(url,options);
    };
  }
  function safeFailure(error){
    if(error instanceof PreviewBuildPolicyUnavailable)
      return fail('The edit paused before any GitHub change. Confirm automatic preview builds are off, then review the preview again.',409);
    if(error instanceof ImportedEditError)
      return fail(SAFE[error.code]||'The imported edit was refused. No pull request was opened.',400);
    return fail('The imported edit could not be prepared. No pull request was opened.',409);
  }
  async function ownedZip(env,current,id){
    if(!current?.cloudflare_account_id||!current.cloudflare_token_ct||!isLaunchId(id))return null;
    const job=await getOwnedJob(env,current,id,now());
    if(!job||job.status!=='live'||job.production_branch!=='main'||
       !Number.isSafeInteger(job.repository_id)||job.repository_id<1||
       !Number.isSafeInteger(job.github_user_id)||job.github_user_id!==current.github_user_id||
       typeof job.pages_project_id!=='string'||!job.pages_project_id||
       job.github_login?.toLowerCase()!==current.github_login?.toLowerCase())return null;
    let plan;
    try{plan=JSON.parse(job.plan_json);}catch{return null;}
    if(!plan||plan.site||plan.customer!==job.site_slug||!isZipArtifact(plan.zip))return null;
    const grants=await assertHistoryAccess(env,current);
    return {job,grants};
  }
  function ticketAad(kind,current){
    return kind==='review'?'imported-edit-review:'+current.hash:'imported-edit-status';
  }
  // shortcut: each preview leaves a draft object in ZIP_ARTIFACTS. Delete draft keys when a lifecycle rule exists.
  async function stageEditPreview(env,files){
    if(!zipPreviewConfigured(env))return null;
    const ordered=[...files].sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
    const artifact=await stageZip(env.ZIP_ARTIFACTS,crypto.randomUUID(),ordered);
    if(artifact.digest!==await artifactDigest(ordered))throw new ImportedEditError('approval_mismatch');
    return artifact;
  }
  async function encodeTicket(env,kind,current,payload){
    return seal(env.TOKEN_ENCRYPTION_KEY,JSON.stringify({
      version:1,kind,createdAt:now(),expiresAt:now()+(kind==='review'?REVIEW_LIFETIME:STATUS_LIFETIME),
      githubUserId:current.github_user_id,cloudflareAccountId:current.cloudflare_account_id,
      authorizationEpoch:kind==='review'?current.authorization_epoch:null,...payload
    }),ticketAad(kind,current));
  }
  async function decodeTicket(env,kind,current,raw){
    if(!current?.cloudflare_account_id||typeof raw!=='string'||raw.length<50||raw.length>6000||
       !/^[A-Za-z0-9_-]+$/.test(raw))throw new ImportedEditError('approval-digest-mismatch');
    let value;
    try{value=JSON.parse(await unseal(env.TOKEN_ENCRYPTION_KEY,raw,ticketAad(kind,current)));}
    catch{throw new ImportedEditError('approval-digest-mismatch');}
    const time=now(),lifetime=kind==='review'?REVIEW_LIFETIME:STATUS_LIFETIME;
    if(value?.kind!==kind||value.version!==1||value.githubUserId!==current.github_user_id||
       value.cloudflareAccountId!==current.cloudflare_account_id||
       !Number.isSafeInteger(value.createdAt)||value.createdAt>time||value.expiresAt!==value.createdAt+lifetime||
       value.expiresAt<=time||(kind==='review'&&value.authorizationEpoch!==current.authorization_epoch)||
       !isLaunchId(value.jobId)||!Number.isSafeInteger(value.repositoryId)||
       !SHA.test(value.baseCommitSha||'')||!DIGEST.test(value.artifactDigest||'')||
       (kind==='review'&&(!DIGEST.test(value.previewDigest||'')||!DIGEST.test(value.proposalDigest||'')||
         !/^[a-f0-9]{32}$/.test(value.approvalId||''))))
      throw new ImportedEditError('approval-digest-mismatch');
    return value;
  }
  function oneField(form,name,max){
    const values=form.getAll(name);
    const value=values[0];
    if(values.length!==1||typeof value!=='string'||value.length<1||value.length>max)return null;
    return value;
  }
  async function reviewedTree(env,current,ticket,item){
    if(ticket.repositoryId!==item.job.repository_id||typeof ticket.requestId!=='string'||typeof ticket.summary!=='string'||
       !Array.isArray(ticket.edits)||ticket.edits.length!==1||
       !Array.isArray(ticket.changed)||ticket.changed.length!==1)throw new ImportedEditError('approval-digest-mismatch');
    const fetchFn=fencedFetch(env,current);
    const revision=await readCurrentRevision({
      owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
      token:item.grants.githubAccessToken,fetchFn
    });
    if(revision.commitSha!==ticket.baseCommitSha||revision.repositoryId!==item.job.repository_id||
       revision.githubUserId!==item.job.github_user_id)throw new ImportedEditError('stale_base');
    const files=revision.files.map(file=>({path:file.path,bytes:file.bytes}));
    const inspection=await inspectSite(files);
    if(inspection.classification!=='static'&&inspection.classification!=='static_multipage'){
      throw new ImportedEditError(inspection.classification==='compiled_bundle'?'compiled_bundle':inspection.classification==='unsupported'?'unsupported':'source_project');
    }
    const proposal=parseModelOutput(JSON.stringify({
      v:1,requestId:ticket.requestId,repositoryId:ticket.repositoryId,baseCommitSha:revision.commitSha,
      summary:ticket.summary,edits:ticket.edits
    }));
    const validated=await validateEdits({
      baseCommitSha:revision.commitSha,files,inspection,proposal,repositoryId:revision.repositoryId
    });
    const preview=await isolatePreview({
      files:validated.files,baseCommitSha:revision.commitSha,githubUserId:revision.githubUserId,
      repositoryId:revision.repositoryId,ownerLogin:revision.ownerLogin
    });
    if(preview.digest!==ticket.previewDigest||validated.proposalDigest!==ticket.proposalDigest||
       validated.artifactDigest!==ticket.artifactDigest)throw new ImportedEditError('approval_mismatch');
    const approvedRows=JSON.stringify(ticket.changed);
    const actualRows=JSON.stringify(validated.changed);
    if(approvedRows!==actualRows)throw new ImportedEditError('approval-digest-mismatch');
    return {files,validated,preview};
  }
  function reasonLines(inspection){
    return inspection.reasons
      .filter(code=>code!=='has_index_html'&&code!=='external_dependency')
      .map(code=>REASON[code])
      .filter(Boolean);
  }
  async function currentInspection(env,current,item){
    const fetchFn=fencedFetch(env,current);
    const revision=await readCurrentRevision({
      owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
      token:item.grants.githubAccessToken,fetchFn
    });
    return inspectSite(revision.files.map(file=>({path:file.path,bytes:file.bytes})));
  }
  async function editor(env,current,id){
    const item=await ownedZip(env,current,id);
    if(!item)return fail('Open a live imported website you own from your launches.',404);
    let inspection;
    try{inspection=await currentInspection(env,current,item);}
    catch(error){return safeFailure(error);}
    const notes=reasonLines(inspection).map(line=>'<p>'+escape(line)+'</p>').join('');
    const heading='<p><strong>Repository:</strong> '+escape('esp-'+item.job.site_slug)+'</p>';
    if(inspection.classification!=='static'&&inspection.classification!=='static_multipage'){
      return view('Edit imported website',heading+notes+'<p><a href="/history">Back to your launches</a></p>');
    }
    const paths=inspection.files.filter(file=>file.editable.length).map(file=>{
      const path=file.path.startsWith('public/')?file.path.slice('public/'.length):file.path;
      const labels=file.editable.map(kind=>KIND_LABEL[kind]||kind).join(', ');
      return '<li><code>'+escape(path)+'</code> ('+escape(labels)+')</li>';
    }).join('');
    const fields=[
      '<input type="hidden" name="id" value="'+escape(id)+'">',
      '<label for="kind">Change</label><select id="kind" name="kind">'+
        '<option value="text">Unique visible text</option>'+
        '<option value="link">Unique link address</option>'+
        '<option value="business_info">Unique business email or phone</option>'+
        '<option value="css_color">Existing CSS custom property color</option></select>',
      '<label for="old">Current text on your site</label><input id="old" name="old" maxlength="500" required>',
      '<label for="replacement">Replacement</label><input id="replacement" name="replacement" maxlength="500" required>',
      '<details><summary>Same text on more than one page?</summary>'+
        '<label for="path">Page file (optional)</label><input id="path" name="path" maxlength="240" placeholder="contact.html"></details>'
    ].join('');
    return view('Edit imported website','<p>Type the text as it appears on your site and what it should say instead. We find the page it is on, show you a preview, and prepare a pull request. Nothing is merged or published for you.</p>'+
      heading+notes+
      (paths?'<p>Files you can edit:</p><ul>'+paths+'</ul>':'')+
      button('/imported-edit-preview','Preview this edit',current.csrf,fields)+
      '<p><a href="/history">Back to your launches</a></p>');
  }
  async function prepare(request,env,current){
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    const item=await ownedZip(env,current,oneField(form,'id',80));
    if(!item)return fail('This live imported website is not available for editing.',404);
    const kind=oneField(form,'kind',40);
    const rawPath=form.get('path');
    const path=typeof rawPath==='string'&&rawPath.trim()===''&&form.getAll('path').length<=1?null:oneField(form,'path',240);
    if(path===null&&form.getAll('path').length>1)return fail('Enter one page file.',400);
    const oldValue=oneField(form,'old',500);
    const replacement=oneField(form,'replacement',500);
    if(!KINDS.has(kind)||!oldValue||!replacement||(rawPath!=null&&rawPath.trim()!==''&&!path))return fail('Enter the current text and the replacement.',400);
    try{
      const fetchFn=fencedFetch(env,current);
      const revision=await readCurrentRevision({
        owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
        token:item.grants.githubAccessToken,fetchFn
      });
      const files=revision.files.map(file=>({path:file.path,bytes:file.bytes}));
      const inspection=await inspectSite(files);
      if(inspection.classification!=='static'&&inspection.classification!=='static_multipage'){
      throw new ImportedEditError(inspection.classification==='compiled_bundle'?'compiled_bundle':inspection.classification==='unsupported'?'unsupported':'source_project');
    }
      const requestId=crypto.randomUUID();
      const summary='Owner preview';
      const attempt=async relative=>{
        const source=files.find(file=>file.path===relative);
        if(!source)throw new ImportedEditError('kind_not_allowed');
        const contractEdits=[{
          kind,path:'public/'+relative,expectedBlobSha:await gitBlobSha(source.bytes),find:oldValue,replace:replacement
        }];
        const proposal=parseModelOutput(JSON.stringify({
          v:1,requestId,repositoryId:revision.repositoryId,baseCommitSha:revision.commitSha,summary,edits:contractEdits
        }));
        const validated=await validateEdits({
          baseCommitSha:revision.commitSha,files,inspection,proposal,repositoryId:revision.repositoryId
        });
        return {contractEdits,validated};
      };
      let located;
      if(path){
        located=await attempt(path.startsWith('public/')?path.slice('public/'.length):path);
      }else{
        // No page given: try every file that allows this kind of edit, and use the one place the text appears.
        const candidates=inspection.files.filter(file=>file.editable.includes(kind))
          .map(file=>file.path.startsWith('public/')?file.path.slice('public/'.length):file.path);
        const matches=[];let lastError;
        for(const relative of candidates){
          try{matches.push({relative,...await attempt(relative)});}catch(error){lastError=error;}
        }
        if(matches.length>1)return fail('That text is on more than one page: '+matches.map(m=>m.relative).join(', ')+
          '. Open "Same text on more than one page?" and enter the page file to change.',400);
        if(!matches.length)throw lastError instanceof ImportedEditError&&lastError.code!=='no_match'?lastError:new ImportedEditError('not_found_anywhere');
        located=matches[0];
      }
      const {contractEdits,validated}=located;
      if(validated.changed.length!==1)throw new ImportedEditError('context_not_allowed');
      const previewArtifact=await stageEditPreview(env,validated.files);
      const preview=await isolatePreview({
        files:validated.files,baseCommitSha:revision.commitSha,githubUserId:revision.githubUserId,
        repositoryId:revision.repositoryId,ownerLogin:revision.ownerLogin
      });
      const ticket=await encodeTicket(env,'review',current,{
        jobId:item.job.id,repositoryId:item.job.repository_id,baseCommitSha:revision.commitSha,
        previewDigest:preview.digest,proposalDigest:validated.proposalDigest,artifactDigest:validated.artifactDigest,
        approvalId:newApprovalId(),requestId,summary,edits:contractEdits,changed:validated.changed,
        ...(previewArtifact?{previewArtifact}:{})
      });
      return new Response(null,{status:303,headers:{
        location:'/imported-edit-review?ticket='+encodeURIComponent(ticket),
        'cache-control':'no-store','referrer-policy':'same-origin'
      }});
    }catch(error){
      return safeFailure(error);
    }
  }
  async function review(env,current,raw){
    try{
      const ticket=await decodeTicket(env,'review',current,raw);
      if(!Array.isArray(ticket.edits)||ticket.edits.length!==1)throw new ImportedEditError('approval-digest-mismatch');
      const item=await ownedZip(env,current,ticket.jobId);
      if(!item)return fail('This imported edit preview expired or the website is no longer yours.',404);
      await reviewedTree(env,current,ticket,item);
      const edit=ticket.edits[0];
      const relative=edit.path.startsWith('public/')?edit.path.slice('public/'.length):edit.path;
      const fileLink='/imported-edit-file?ticket='+encodeURIComponent(raw)+'&path='+encodeURIComponent(relative);
      const screen=editReviewMarkup({
        proposal:{v:1,summary:ticket.summary,edits:ticket.edits},
        binding:{
          approvalId:ticket.approvalId,proposalDigest:ticket.proposalDigest,artifactDigest:ticket.artifactDigest,
          baseCommitSha:ticket.baseCommitSha,expiresAt:ticket.expiresAt
        },
        approve:{action:'/imported-edit-approve',csrf:current.csrf},
        ticket:raw,now:now()*1000
      });
      let previewForm='',headers;
      if(isZipArtifact(ticket.previewArtifact)&&zipPreviewConfigured(env)){
        const opened=await createZipPreview(env,ticket.previewArtifact,'draft',current.expires_at);
        previewForm='<form action="'+escape(opened.origin+'/_open')+'" method="POST" target="_blank">'+
          '<input name="ticket" type="hidden" value="'+escape(opened.ticket)+'">'+
          '<button type="submit">Open the exact preview</button></form>'+
          '<p>Opens a private preview of these files on a separate address. Scripts stay blocked. Your live site is unchanged.</p>';
        headers={
          'content-type':'text/html; charset=utf-8','cache-control':'no-store',
          // 'origin', not 'same-origin': browsers send Origin: null on cross-site POSTs under same-origin, and /_open rejects that.
          'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'origin',
          'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' "+opened.origin+"; base-uri 'none'; frame-ancestors 'none'"
        };
      }
      const body=screen+previewForm+
        '<p><a href="'+escape(fileLink)+'">See the exact changed file</a></p>'+
        '<p><a href="/imported-edit?id='+encodeURIComponent(item.job.id)+'">Start over</a></p>';
      return headers?view('Review imported edit',body,200,headers):view('Review imported edit',body);
    }catch(error){
      if(error instanceof ImportedEditError)return safeFailure(error);
      return fail('This imported edit preview expired or your account changed. Start a fresh edit.',400);
    }
  }
  async function file(env,current,url){
    try{
      const ticket=await decodeTicket(env,'review',current,url.searchParams.get('ticket'));
      const item=await ownedZip(env,current,ticket.jobId);
      if(!item)return fail('This exact file preview is unavailable.',404);
      const {validated}=await reviewedTree(env,current,ticket,item);
      const response=previewResponse({credentialsIncluded:false,files:validated.files},'/'+(url.searchParams.get('path')||''));
      return new Response(response.body,{status:response.status,headers:response.headers});
    }catch(error){
      if(error instanceof ImportedEditError)return safeFailure(error);
      return fail('This exact file preview is unavailable.',404);
    }
  }
  async function approve(request,env,current){
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    try{
      const ticket=await decodeTicket(env,'review',current,oneField(form,'ticket',6000));
      const item=await ownedZip(env,current,ticket.jobId);
      if(!item)return fail('This approval does not match a website you own.',404);
      if(oneField(form,'approvalId',32)!==ticket.approvalId||oneField(form,'proposalDigest',64)!==ticket.proposalDigest||
         oneField(form,'artifactDigest',64)!==ticket.artifactDigest)throw new ImportedEditError('approval_mismatch');
      const {files,validated,preview}=await reviewedTree(env,current,ticket,item);
      const receipt=await bindApproval({
        explicitlyApproved:true,preview,changed:validated.changed,
        githubUserId:item.job.github_user_id,repositoryId:item.job.repository_id,
        ownerLogin:item.job.github_login,repository:item.job.github_login+'/esp-'+item.job.site_slug,
        baseCommitSha:ticket.baseCommitSha,proposalDigest:validated.proposalDigest,
        approvalId:ticket.approvalId,expiresAt:ticket.expiresAt
      });
      const fetchFn=guardedFetch(env,current,item.job,item.grants.cloudflareAccessToken);
      const proposal=await proposeImportedPullRequest(receipt,{baseFiles:files,nextFiles:validated.files},{
        githubToken:item.grants.githubAccessToken,fetchFn,approvalStore:d1ApprovalStore(env.DB)
      });
      if(proposal.live!==false||proposal.merged!==false)throw new ImportedEditError('pull-request-unreadable');
      const status=await encodeTicket(env,'status',current,{
        jobId:item.job.id,repositoryId:item.job.repository_id,baseCommitSha:ticket.baseCommitSha,
        artifactDigest:receipt.artifactDigest,proposalDigest:ticket.proposalDigest,approvalDigest:receipt.digest,
        summary:ticket.summary,edits:ticket.edits,
        changed:validated.changed,number:proposal.number,headCommitSha:proposal.headCommitSha
      });
      return new Response(null,{status:303,headers:{
        location:'/imported-edit-status?ticket='+encodeURIComponent(status),
        'cache-control':'no-store','referrer-policy':'same-origin'
      }});
    }catch(error){
      return safeFailure(error);
    }
  }
  function statusScreen(ticket,reviewStatus,code){
    try{
      if(!Array.isArray(ticket.edits)||ticket.edits.length<1||!DIGEST.test(ticket.proposalDigest||'')||typeof ticket.summary!=='string')return '';
      return editReviewMarkup({
        proposal:{v:1,summary:ticket.summary,edits:ticket.edits},
        binding:{proposalDigest:ticket.proposalDigest,artifactDigest:ticket.artifactDigest,baseCommitSha:ticket.baseCommitSha},
        status:reviewStatus,code
      });
    }catch{return '';}
  }
  function reviewState(pull,published){
    if(pull.status==='rejected')return {status:'rejected'};
    if(pull.status==='failed')return {status:'failed',code:'stale_base'};
    if(pull.status==='merged'&&published.live)return {status:'live'};
    if(pull.status==='merged'&&published.status==='deploy_unverified')return {status:'merged',code:'deploy_unverified'};
    if(pull.status==='merged')return {status:'deploying'};
    return {status:'pr_open'};
  }
  async function status(env,current,raw){
    let ticket;
    try{
      ticket=await decodeTicket(env,'status',current,raw);
      if(!DIGEST.test(ticket.approvalDigest||'')||!Number.isSafeInteger(ticket.number)||ticket.number<1||
         !SHA.test(ticket.headCommitSha||''))return fail('This update receipt is invalid.',400);
      const item=await ownedZip(env,current,ticket.jobId);
      if(!item||item.job.repository_id!==ticket.repositoryId)
        return fail('This update does not belong to your connected accounts.',404);
      const fetchFn=fencedFetch(env,current);
      let pull;
      try{
        pull=await readImportedPullRequest({
          ownerLogin:item.job.github_login,repository:item.job.github_login+'/esp-'+item.job.site_slug,
          repositoryId:item.job.repository_id,owner:{provider:'github',id:String(item.job.github_user_id)},
          baseCommitSha:ticket.baseCommitSha,artifactDigest:ticket.artifactDigest,digest:ticket.approvalDigest
        },{githubToken:item.grants.githubAccessToken,fetchFn,number:ticket.number,headCommitSha:ticket.headCommitSha});
      }catch(error){
        if(error instanceof ImportedEditError&&error.code==='credentials_revoked'){
          const screen=statusScreen(ticket,'needs_reauthorization','credentials_revoked');
          if(screen)return view('Imported edit status',screen+'<p><a href="/history">Back to your launches</a></p>');
        }
        throw error;
      }
      let published={live:false,status:'deploying'};
      if(pull.status==='merged'&&Array.isArray(ticket.changed)&&ticket.changed.length){
        published=await verifyPublishedRevision({
          accountId:item.job.cloudflare_account_id,projectName:'esp-'+item.job.site_slug+'-site',
          expectedCommitSha:pull.mergedCommitSha,cloudflareToken:item.grants.cloudflareAccessToken,fetchFn,
          publicUrl:'https://esp-'+item.job.site_slug+'-site.pages.dev/',
          changedFiles:ticket.changed.map(row=>({path:row.path,sha256:row.afterSha256}))
        });
      }
      const review=reviewState(pull,published);
      const screen=statusScreen(ticket,review.status,review.code);
      const detail=published.live
        ?'The published production revision matches the merged commit.'
        :pull.status==='merged'&&published.status==='deploy_unverified'
          ?'GitHub shows the merge. The live revision does not match the approved edit yet, so the site is not live.'
        :pull.status==='merged'
          ?'GitHub shows the merge. Production has not finished deploying it, so the site is not live.'
          :pull.status==='rejected'
            ?'The pull request was closed without a merge. The site was not published from this edit.'
          :pull.status==='failed'
            ?'The pull request no longer matches the approved edit. The site was not published from this edit.'
            :'The pull request is open. Merge it yourself in GitHub. This page does not publish the site.';
      const follow=review.status==='pr_open'
        ?'<p>Merge it yourself in GitHub. This page does not publish the site.</p>':'';
      return view('Imported edit status',
        '<p><strong>Site:</strong> '+escape(item.job.customer_name)+'</p>'+
        (screen||'<p>'+escape(detail)+'</p>')+follow+
        (pull.pullRequest?'<p><a href="'+escape(pull.pullRequest)+'" target="_blank" rel="noopener noreferrer">Open the pull request</a> (opens in a new tab)</p>':'')+
        '<p><a href="/history">Back to your launches</a></p>');
    }catch(error){
      return safeFailure(error);
    }
  }
  return {editor,prepare,review,file,approve,status};
}
