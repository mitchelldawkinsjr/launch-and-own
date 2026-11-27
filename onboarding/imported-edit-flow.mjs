// Hosted imported-site edits. The owner session, CSRF check, and launch record
// decide who can ask. Model output is not accepted on these routes.
import {base64Decode,encodeUtf8,gitBlobSha,jcs,sha256Bytes,sha256Text,utf8} from '../imported/bytes.mjs';
import {connectContactForm,formConnectSummary,FormConnectError} from './form-connect.mjs';
import {detectContactForm} from './form-detection.mjs';
import {readFormService} from './form-service.mjs';
import {bindApproval,newApprovalId} from '../imported/approval.mjs';
import {d1ApprovalStore} from '../imported/approval-store.mjs';
import {ImportedEditError} from '../imported/errors.mjs';
import {inspectSite,structuralPath} from '../imported/intelligence.mjs';
import {locateTypedEdit} from '../imported/locate.mjs';
import {parseModelOutput,validateEdits,validatePageSnapshot} from '../imported/edits.mjs';
import {defaultEditorPage,editablePages,listEditTargets,pickEditTarget} from '../imported/targets.mjs';
import {assistantPromptMarkup,livePreviewUrl,pagesDevPreviewUrl,VISUAL_EDITOR_CSS,visualEditorMarkup} from './visual-editor.mjs';
import {artifactDigest,isolatePreview,previewResponse,scriptFreePreviewHeaders} from '../imported/preview.mjs';
import {proposeImportedPullRequest,readImportedPullRequest} from '../imported/pull-request.mjs';
import {readCurrentRevision} from '../imported/revision.mjs';
import {verifyPublishedRevision} from '../imported/verify-published.mjs';
import {MergeRefused,mergeVerifiedPullRequest} from '../pipeline/merge-approved-pr.mjs';
import {getOwnedJob,hasCurrentOwnerSession,isLaunchId} from './launch-jobs.mjs';
import {seal,unseal} from './crypto.mjs';
import {isZipArtifact,loadZipFiles,stageZip} from './zip-artifacts.mjs';
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
  'form_service_not_ready':'Set up the form service first from Optional features. No pull request was opened.',
  'form_not_found':'We could not find your contact form in the current files. No pull request was opened.',
  'form_already_connected':'Your contact form is already connected.',
  'page_body_missing':'That page has no body element, so the form could not be connected.',
  'site_policy_unreadable':'The page\'s security settings could not be updated safely. No pull request was opened.',
  'not_found_anywhere':'We could not find that text on any page you can edit. Copy it exactly as it appears on your site.',
  'ambiguous_pages':'That text is on more than one page. Choose the page in the editor or enter the page file under Advanced.',
  'context_not_allowed':'That change is not allowed as saved. Keep existing scripts as they are, and do not add new scripts, click handlers, or data URLs.',
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

function htmlIncludesAsset(html,path){
  if(typeof html!=='string'||typeof path!=='string'||!path)return false;
  // Require a real attribute/url reference so a removed image cannot ride along in the images[].
  const escaped=path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(?:\\bsrc\\s*=\\s*["\']|url\\(\\s*["\']?)'+escaped,'i').test(html);
}

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
    if(ticket.mode==='snapshot')return reviewSnapshot(env,current,ticket,item);
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
  async function reviewSnapshot(env,current,ticket,item){
    if(ticket.repositoryId!==item.job.repository_id||typeof ticket.requestId!=='string'||typeof ticket.summary!=='string'||
       !isZipArtifact(ticket.previewArtifact)||!Array.isArray(ticket.edits)||ticket.edits.length<1||
       ticket.edits.some(edit=>edit?.kind!=='page_snapshot')||
       !Array.isArray(ticket.changed)||ticket.changed.length<1||ticket.changed.length!==ticket.edits.length){
      throw new ImportedEditError('approval-digest-mismatch');
    }
    const fetchFn=fencedFetch(env,current);
    const revision=await readCurrentRevision({
      owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
      token:item.grants.githubAccessToken,fetchFn
    });
    if(revision.commitSha!==ticket.baseCommitSha||revision.repositoryId!==item.job.repository_id||
       revision.githubUserId!==item.job.github_user_id)throw new ImportedEditError('stale_base');
    const files=revision.files.map(file=>({path:file.path,bytes:file.bytes}));
    const inspection=await inspectSite(files);
    const stored=await loadZipFiles(env.ZIP_ARTIFACTS,ticket.previewArtifact,'draft');
    const expectedBlobs=new Map(ticket.changed.filter(row=>typeof row.beforeBlobSha==='string').map(row=>[row.path,row.beforeBlobSha]));
    const validated=await validatePageSnapshot({
      baseCommitSha:revision.commitSha,files,inspection,repositoryId:revision.repositoryId,
      requestId:ticket.requestId,summary:ticket.summary,nextFiles:stored,expectedBlobs
    });
    const preview=await isolatePreview({
      files:validated.files,baseCommitSha:revision.commitSha,githubUserId:revision.githubUserId,
      repositoryId:revision.repositoryId,ownerLogin:revision.ownerLogin
    });
    if(preview.digest!==ticket.previewDigest||validated.proposalDigest!==ticket.proposalDigest||
       validated.artifactDigest!==ticket.artifactDigest||
       JSON.stringify(validated.changed)!==JSON.stringify(ticket.changed))throw new ImportedEditError('approval_mismatch');
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
  const editorCsp="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-src 'self' https://*.pages.dev; frame-ancestors 'none'";
  const editorHeaders={
    'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY',
    'x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':editorCsp
  };
  async function editor(env,current,id,url){
    const item=await ownedZip(env,current,id);
    if(!item)return fail('Open a live imported website you own from your launches.',404);
    let inspection,revision,files;
    try{
      const fetchFn=fencedFetch(env,current);
      revision=await readCurrentRevision({
        owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
        token:item.grants.githubAccessToken,fetchFn
      });
      files=revision.files.map(file=>({path:file.path,bytes:file.bytes}));
      inspection=await inspectSite(files);
    }catch(error){return safeFailure(error);}
    const notes=reasonLines(inspection).map(line=>'<p>'+escape(line)+'</p>').join('');
    const heading='<p><strong>Repository:</strong> '+escape('esp-'+item.job.site_slug)+'</p>';
    if(inspection.classification!=='static'&&inspection.classification!=='static_multipage'){
      return view('Edit imported website',heading+notes+'<p><a href="/history">Back to your launches</a></p>');
    }
    const pages=editablePages(inspection);
    const rawPage=url?.searchParams?.get('page');
    const page=typeof rawPage==='string'&&pages.includes(rawPage)?rawPage:defaultEditorPage(pages);
    const targets=listEditTargets(files,inspection);
    const picked=pickEditTarget(targets,url?.searchParams?.get('pick'));
    const previewView=url?.searchParams?.get('view')==='live'?'live':'mirror';
    const iframeSrc=livePreviewUrl('/imported-edit-live/',page,{jobId:id});
    const liveSiteSrc=pagesDevPreviewUrl(item.job.site_slug,page);
    const aiBlock=env.EDITOR_ASSISTANT_PROMPT==='on'
      ?assistantPromptMarkup({csrf:current.csrf,action:'/imported-edit-preview',id}):'';
    const body=notes+visualEditorMarkup({
      jobId:id,page,pages,iframeSrc,previewView,liveSiteSrc,targets,picked,csrf:current.csrf,
      previewAction:'/imported-edit-preview',editorPath:'/imported-edit',aiBlock,
      meta:'Repository: esp-'+item.job.site_slug,
      notes:'<p>When you approve, we publish exactly that change. You can choose to open a pull request instead and merge it yourself.</p>'+
        '<p class="muted">Scripts stay off in the editor so your Launch &amp; Own session stays safe. Use the open-in-new-tab control (external-link icon) to see menus, carousels, and other features that need JavaScript.</p>'
    })+'<p><a href="/history">Back to your launches</a></p>';
    return view('Edit imported website',body,200,editorHeaders,{wide:true,css:VISUAL_EDITOR_CSS,omitTitle:true});
  }
  async function projectFiles(env,current,id){
    const item=await ownedZip(env,current,id);
    if(!item)return fail('This live imported website is not available for editing.',404);
    try{
      const fetchFn=fencedFetch(env,current);
      const revision=await readCurrentRevision({
        owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
        token:item.grants.githubAccessToken,fetchFn
      });
      const paths=revision.files.map(file=>file.path).sort();
      return Response.json({files:paths},{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    }catch(error){
      return safeFailure(error);
    }
  }
  async function live(env,current,url){
    const rest=url.pathname.startsWith('/imported-edit-live/')?url.pathname.slice('/imported-edit-live/'.length):'';
    const split=rest.indexOf('/');
    if(split<1)return fail('This preview page is not available.',404);
    const id=decodeURIComponent(rest.slice(0,split));
    const relative=decodeURIComponent(rest.slice(split+1))||'index.html';
    if(!isLaunchId(id)||!structuralPath(relative))return fail('This preview page is not available.',404);
    const item=await ownedZip(env,current,id);
    if(!item)return fail('This preview is not available.',404);
    try{
      const fetchFn=fencedFetch(env,current);
      const revision=await readCurrentRevision({
        owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
        token:item.grants.githubAccessToken,fetchFn
      });
      const response=previewResponse({credentialsIncluded:false,files:revision.files},'/'+relative);
      const headers={...response.headers,...scriptFreePreviewHeaders({frameAncestors:'self'})};
      return new Response(response.body,{status:response.status,headers});
    }catch(error){
      if(error instanceof ImportedEditError)return safeFailure(error);
      return fail('This preview is not available.',404);
    }
  }
  async function readVisualBody(request){
    const type=request.headers.get('content-type')||'';
    if(/^application\/json(?:\s*;|$)/i.test(type)){
      const bytes=await request.arrayBuffer();
      if(bytes.byteLength<2||bytes.byteLength>3_000_000)return null;
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return null;}
    }
    // Top-level form POST from the editor iframe (avoids fetch/"Failed to fetch" in the canvas host).
    if(/^(?:application\/x-www-form-urlencoded|multipart\/form-data)(?:\s*;|$)/i.test(type)){
      let form;
      try{form=await request.formData();}catch{return null;}
      const imagesRaw=form.get('images');
      let images=[];
      if(typeof imagesRaw==='string'&&imagesRaw.trim()){
        try{
          const parsed=JSON.parse(imagesRaw);
          if(!Array.isArray(parsed))return null;
          images=parsed;
        }catch{return null;}
      }
      return {
        csrf:typeof form.get('csrf')==='string'?form.get('csrf'):'',
        id:typeof form.get('id')==='string'?form.get('id'):'',
        page:typeof form.get('page')==='string'?form.get('page'):'',
        html:typeof form.get('html')==='string'?form.get('html'):'',
        images
      };
    }
    return null;
  }
  async function visualPreview(request,env,current){
    await limitAttempts(request,env);
    const body=await readVisualBody(request);
    if(!current||!body||request.headers.get('origin')!==baseUrl(env)||body.csrf!==current.csrf)
      return fail('This form expired. Please reload the page',400);
    const id=typeof body.id==='string'?body.id:'';
    const page=typeof body.page==='string'?body.page:'';
    let html=typeof body.html==='string'?body.html:'';
    html=html.replace(/<base\b[^>]*id=(?:"__he_base__"|'__he_base__')[^>]*>/gi,'');
    const images=Array.isArray(body.images)?body.images:[];
    if(!isLaunchId(id)||!structuralPath(page)||!html||html.length>1_500_000||images.length>8)
      return fail('Enter the page to preview.',400);
    const item=await ownedZip(env,current,id);
    if(!item)return fail('This live imported website is not available for editing.',404);
    try{
      const fetchFn=fencedFetch(env,current);
      const revision=await readCurrentRevision({
        owner:item.job.github_login,repo:'esp-'+item.job.site_slug,
        token:item.grants.githubAccessToken,fetchFn
      });
      const files=revision.files.map(file=>({path:file.path,bytes:file.bytes}));
      const inspection=await inspectSite(files);
      const next=files.map(file=>({path:file.path,bytes:file.path===page?encodeUtf8(html):file.bytes}));
      if(!next.some(file=>file.path===page))throw new ImportedEditError('kind_not_allowed');
      // Only keep uploaded images the page HTML still references (add-then-remove must not open a PR file).
      const referenced=images.filter(image=>image&&typeof image.path==='string'&&htmlIncludesAsset(html,image.path));
      for(const image of referenced){
        if(typeof image.base64!=='string'||image.base64.length>2_800_000)throw new ImportedEditError('kind_not_allowed');
        if(!/^images\/[a-z0-9][a-z0-9._-]{0,64}\.(png|jpe?g|gif|webp)$/i.test(image.path))
          throw new ImportedEditError('kind_not_allowed');
        let bytes;
        try{bytes=base64Decode(image.base64);}catch{throw new ImportedEditError('kind_not_allowed');}
        if(next.some(file=>file.path===image.path))throw new ImportedEditError('kind_not_allowed');
        next.push({path:image.path,bytes});
      }
      const requestId=crypto.randomUUID();
      const summary='Visual editor preview';
      const validated=await validatePageSnapshot({
        baseCommitSha:revision.commitSha,files,inspection,repositoryId:revision.repositoryId,
        requestId,summary,nextFiles:next
      });
      const previewArtifact=await stageEditPreview(env,validated.files);
      if(!previewArtifact)return fail('Website ZIP previews are unavailable.',409);
      const preview=await isolatePreview({
        files:validated.files,baseCommitSha:revision.commitSha,githubUserId:revision.githubUserId,
        repositoryId:revision.repositoryId,ownerLogin:revision.ownerLogin
      });
      const edits=validated.changed.map(row=>({
        kind:'page_snapshot',path:row.path,
        find:row.added?'New file':'Current page',
        replace:row.added?'New image':'Updated in the visual editor'
      }));
      const ticket=await encodeTicket(env,'review',current,{
        mode:'snapshot',jobId:item.job.id,repositoryId:item.job.repository_id,baseCommitSha:revision.commitSha,
        previewDigest:preview.digest,proposalDigest:validated.proposalDigest,artifactDigest:validated.artifactDigest,
        approvalId:newApprovalId(),requestId,summary,edits,changed:validated.changed,previewArtifact
      });
      if(ticket.length>6000)throw new ImportedEditError('limit_exceeded');
      return new Response(null,{status:303,headers:{
        location:'/imported-edit-review?ticket='+encodeURIComponent(ticket),
        'cache-control':'no-store','referrer-policy':'same-origin'
      }});
    }catch(error){
      return safeFailure(error);
    }
  }
  async function prepare(request,env,current){
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    const item=await ownedZip(env,current,oneField(form,'id',80));
    if(!item)return fail('This live imported website is not available for editing.',404);
    if(form.get('mode')==='ai')return fail('A described change is prepared in the customer-owned assistant. Use Preview in the editor, or Advanced, on this page.',400);
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
      let located;
      try{
        located=await locateTypedEdit({
          files,inspection,revision,kind,find:oldValue,replace:replacement,path,requestId,summary
        });
      }catch(error){
        if(error instanceof ImportedEditError&&error.code==='ambiguous_pages'){
          return fail('That text is on more than one page: '+error.paths.join(', ')+
            '. Choose the page in the editor or enter the page file under Advanced.',400);
        }
        throw error;
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
      const snapshot=ticket.mode==='snapshot';
      if(snapshot){
        if(!Array.isArray(ticket.edits)||ticket.edits.length<1||ticket.edits.some(edit=>edit?.kind!=='page_snapshot'))
          throw new ImportedEditError('approval-digest-mismatch');
      }else if(!Array.isArray(ticket.edits)||ticket.edits.length!==1)throw new ImportedEditError('approval-digest-mismatch');
      const item=await ownedZip(env,current,ticket.jobId);
      if(!item)return fail('This imported edit preview expired or the website is no longer yours.',404);
      await reviewedTree(env,current,ticket,item);
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
      const fileLinks=ticket.edits.map(edit=>{
        const relative=edit.path.startsWith('public/')?edit.path.slice('public/'.length):edit.path;
        const href='/imported-edit-file?ticket='+encodeURIComponent(raw)+'&path='+encodeURIComponent(relative);
        return '<li><a href="'+escape(href)+'">See '+escape(relative)+'</a></li>';
      }).join('');
      const filesBlock=ticket.edits.length===1
        ?'<p><a href="'+escape('/imported-edit-file?ticket='+encodeURIComponent(raw)+'&path='+encodeURIComponent(
          ticket.edits[0].path.startsWith('public/')?ticket.edits[0].path.slice('public/'.length):ticket.edits[0].path
        ))+'">See the exact changed file</a></p>'
        :'<p class="er-group-label">Exact changed files</p><ul class="er-file-links">'+fileLinks+'</ul>';
      const body=screen+previewForm+filesBlock+
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
      // Owner decision 2026-11-26: "Approve and publish" merges this exact PR; "Open a pull request instead" leaves it open.
      let mergeNote=null;
      if(form.get('action')!=='pr'){
        try{
          const pull=await readImportedPullRequest(receipt,{githubToken:item.grants.githubAccessToken,fetchFn,number:proposal.number,headCommitSha:proposal.headCommitSha});
          if(pull.status!=='pr_open')throw new MergeRefused('merge_blocked');
          await mergeVerifiedPullRequest({owner:item.job.github_login,repoName:'esp-'+item.job.site_slug,number:proposal.number,
            headCommitSha:proposal.headCommitSha,baseCommitSha:ticket.baseCommitSha},{githubToken:item.grants.githubAccessToken,fetchFn});
        }catch(error){
          if(!(error instanceof MergeRefused))throw error;
          mergeNote=error.code; // the PR stays open; the status page explains why nothing was published
        }
      }
      const status=await encodeTicket(env,'status',current,{mergeNote,
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
      const blocked=ticket.mergeNote==='stale_base'
        ?'Your website changed after you approved, so it was not published automatically. '
        :ticket.mergeNote?'GitHub did not allow an automatic merge, so it was not published. ':'';
      const follow=review.status==='pr_open'
        ?'<p>'+escape(blocked)+'Merge it yourself in GitHub when you are ready. This page does not publish the site.</p>':'';
      return view('Imported edit status',
        '<p><strong>Site:</strong> '+escape(item.job.customer_name)+'</p>'+
        (screen||'<p>'+escape(detail)+'</p>')+follow+
        (pull.pullRequest?'<p><a href="'+escape(pull.pullRequest)+'" target="_blank" rel="noopener noreferrer">Open the pull request</a> (opens in a new tab)</p>':'')+
        '<p><a href="/history">Back to your launches</a></p>');
    }catch(error){
      return safeFailure(error);
    }
  }
  // Contact form connection: the same owned-site, ticket, approval and pull request path as an edit.
  const formService=(env,current,job)=>readFormService(env,current,job.id);
  async function connectedTree(env,current,item,{baseCommitSha,connect}={}){
    const service=await formService(env,current,item.job);
    if(!service)throw new ImportedEditError('form_service_not_ready');
    const revision=await readCurrentRevision({
      owner:item.job.github_login,repo:'esp-'+item.job.site_slug,token:item.grants.githubAccessToken,fetchFn:fencedFetch(env,current)
    });
    if(baseCommitSha&&revision.commitSha!==baseCommitSha)throw new ImportedEditError('stale_base');
    if(revision.repositoryId!==item.job.repository_id||revision.githubUserId!==item.job.github_user_id)
      throw new ImportedEditError('repository-mismatch');
    const files=revision.files.map(file=>({path:file.path,bytes:file.bytes}));
    const form=connect??detectContactForm(files);
    if(!form)throw new ImportedEditError('form_not_found');
    if(connect&&(connect.workerUrl!==service.workerUrl||connect.sitekey!==service.sitekey))
      throw new ImportedEditError('approval_mismatch');
    const source=files.find(file=>file.path===form.path);
    if(!source)throw new ImportedEditError('form_not_found');
    let html;
    try{html=connectContactForm(utf8(source.bytes),{formIndex:form.formIndex,workerUrl:service.workerUrl,sitekey:service.sitekey});}
    catch(error){throw error instanceof FormConnectError?new ImportedEditError(error.code):error;}
    const nextFiles=files.map(file=>file===source?{path:file.path,bytes:encodeUtf8(html)}:file);
    const changed=[{path:'public/'+source.path,beforeBlobSha:await gitBlobSha(source.bytes),afterSha256:await sha256Bytes(encodeUtf8(html))}];
    const preview=await isolatePreview({files:nextFiles,baseCommitSha:revision.commitSha,githubUserId:revision.githubUserId,
      repositoryId:revision.repositoryId,ownerLogin:revision.ownerLogin});
    const target={path:source.path,formIndex:form.formIndex,workerUrl:service.workerUrl,sitekey:service.sitekey};
    const proposalDigest=await sha256Text(jcs({v:1,kind:'form_connect',baseCommitSha:revision.commitSha,...target}));
    return {revision,files,nextFiles,changed,preview,target,proposalDigest,form,
      hasPolicy:/http-equiv\s*=\s*["']?content-security-policy/i.test(utf8(source.bytes)),
      // An inline script (like a "preview only" demo handler) can still stop the form from sending.
      inlineScript:/<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S[\s\S]*?<\/script>/i.test(utf8(source.bytes))};
  }
  async function connectForm(env,current,id){
    const item=await ownedZip(env,current,id);
    // Sites Launch & Own created get the built-in contact form through their normal update preview.
    if(!item)return isLaunchId(id)?new Response(null,{status:303,headers:{location:'/site-update?id='+encodeURIComponent(id),'cache-control':'no-store'}})
      :fail('Open a live website you own from your toolkit.',404);
    try{
      const tree=await connectedTree(env,current,item);
      const value={approvalId:newApprovalId(),proposalDigest:tree.proposalDigest,artifactDigest:await artifactDigest(tree.nextFiles)};
      const ticket=await encodeTicket(env,'review',current,{
        jobId:item.job.id,repositoryId:item.job.repository_id,baseCommitSha:tree.revision.commitSha,
        previewDigest:tree.preview.digest,...value,requestId:crypto.randomUUID(),summary:'Connect contact form',edits:[],
        changed:tree.changed,connect:tree.target
      });
      const where='/'+tree.target.path.replace(/(?:^|\/)index\.html?$/i,'').replace(/\.html?$/i,'');
      const lines=formConnectSummary({path:where,workerUrl:tree.target.workerUrl,hasPolicy:tree.hasPolicy});
      const hidden=(name,val)=>'<input type="hidden" name="'+name+'" value="'+escape(val)+'">';
      return view('Connect your contact form',
        '<p>This prepares a pull request in your GitHub account. Nothing changes on your site until you merge it.</p>'+
        '<p><strong>Form:</strong> <code>'+escape(where)+'</code>'+(tree.form.id?' (<code>'+escape(tree.form.id)+'</code>)':'')+
          ', fields '+tree.form.fields.map(field=>'<code>'+escape(field)+'</code>').join(', ')+'</p>'+
        '<ul>'+lines.map(line=>'<li>'+escape(line)+'</li>').join('')+'</ul>'+
        '<p>Messages are saved in a private database in your own Cloudflare account. Only <code>public/'+escape(tree.target.path)+'</code> changes.</p>'+
        (tree.inlineScript?'<p role="alert"><strong>Check this page\'s own script.</strong> It has a script written into the page, which may stop the form from sending (for example a "preview only" message). This change does not remove scripts. Review it in the pull request, and remove that script there or with your own tools before you merge.</p>':'')+
        button('/form-connect-approve','Approve and open a pull request',current.csrf,
          hidden('ticket',ticket)+hidden('approvalId',value.approvalId)+hidden('proposalDigest',value.proposalDigest)+hidden('artifactDigest',value.artifactDigest))+
        '<p>This approval works once and expires in 15 minutes.</p><p><a href="/toolkit">Back to your toolkit</a></p>');
    }catch(error){
      return safeFailure(error);
    }
  }
  async function connectFormApprove(request,env,current){
    await limitAttempts(request,env);
    const form=await formData(request);assertCsrf(request,form,current,baseUrl(env));
    try{
      const ticket=await decodeTicket(env,'review',current,oneField(form,'ticket',6000));
      if(!ticket.connect||typeof ticket.connect!=='object')throw new ImportedEditError('approval-digest-mismatch');
      const item=await ownedZip(env,current,ticket.jobId);
      if(!item)return fail('This approval does not match a website you own.',404);
      if(oneField(form,'approvalId',32)!==ticket.approvalId||oneField(form,'proposalDigest',64)!==ticket.proposalDigest||
         oneField(form,'artifactDigest',64)!==ticket.artifactDigest)throw new ImportedEditError('approval_mismatch');
      // Rebuild from the current files: the exact same change against the same commit, or nothing.
      const tree=await connectedTree(env,current,item,{baseCommitSha:ticket.baseCommitSha,connect:ticket.connect});
      if(tree.preview.digest!==ticket.previewDigest||tree.proposalDigest!==ticket.proposalDigest||
         JSON.stringify(tree.changed)!==JSON.stringify(ticket.changed))throw new ImportedEditError('approval_mismatch');
      const receipt=await bindApproval({
        explicitlyApproved:true,preview:tree.preview,changed:tree.changed,
        githubUserId:item.job.github_user_id,repositoryId:item.job.repository_id,
        ownerLogin:item.job.github_login,repository:item.job.github_login+'/esp-'+item.job.site_slug,
        baseCommitSha:ticket.baseCommitSha,proposalDigest:tree.proposalDigest,
        approvalId:ticket.approvalId,expiresAt:ticket.expiresAt
      });
      const fetchFn=guardedFetch(env,current,item.job,item.grants.cloudflareAccessToken);
      const proposal=await proposeImportedPullRequest(receipt,{baseFiles:tree.files,nextFiles:tree.nextFiles},{
        githubToken:item.grants.githubAccessToken,fetchFn,approvalStore:d1ApprovalStore(env.DB)
      });
      if(proposal.live!==false||proposal.merged!==false)throw new ImportedEditError('pull-request-unreadable');
      const status=await encodeTicket(env,'status',current,{
        jobId:item.job.id,repositoryId:item.job.repository_id,baseCommitSha:ticket.baseCommitSha,
        artifactDigest:receipt.artifactDigest,proposalDigest:ticket.proposalDigest,approvalDigest:receipt.digest,
        summary:ticket.summary,edits:[],changed:tree.changed,number:proposal.number,headCommitSha:proposal.headCommitSha
      });
      return new Response(null,{status:303,headers:{
        location:'/imported-edit-status?ticket='+encodeURIComponent(status),
        'cache-control':'no-store','referrer-policy':'same-origin'
      }});
    }catch(error){
      return safeFailure(error);
    }
  }
  return {editor,prepare,visualPreview,review,file,approve,status,connectForm,connectFormApprove,live,projectFiles};
}
