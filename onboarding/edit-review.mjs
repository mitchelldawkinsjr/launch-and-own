/** Review screen for a proposed edit to an imported site: changes, exact preview, single-use approval, status.
 * Renders contract §2 (proposal), §3 (binding) and §4 (status/codes) from docs/contracts/IMPORTED_SITE_CONTRACTS.md.
 * The hosted review route renders this. The server still verifies the sealed ticket and the recomputed digests. */
import {escape} from './ui.mjs';

const KINDS={text:'Text',link:'Link',business_info:'Business details',css_color:'Color',page_snapshot:'Visual page'};
const STEPS=[['previewed','Preview ready'],['approved','You approved'],['pr_open','Pull request open'],['merged','You merged'],['deploying','Cloudflare publishing'],['live','Live and checked']];
const TERMINAL={rejected:'Not approved',failed:'Stopped',expired:'Expired',needs_reauthorization:'Reconnect needed'};
const CODES={
  no_match:'The text to change was not found. The file may have changed.',
  ambiguous_match:'That text appears more than once, so we could not tell which one to change.',
  kind_not_allowed:'That kind of change is not allowed in this file.',
  context_not_allowed:'The change would touch code, not visible text, links or colors.',
  overlapping_edits:'Two changes overlap. Ask for them one at a time.',
  limit_exceeded:'The change is too large. Ask for a smaller change.',
  invalid_output:'The suggested change was not in a form we can check, so it was discarded.',
  unrelated_change:'Applying it would have changed other files, so it was stopped.',
  missing_local_dependency:'The change would break a link to a file in your site.',
  stale_base:'Your website files changed since this preview. Ask again for a fresh preview.',
  approval_mismatch:'This approval does not match the preview you saw.',
  approval_consumed:'This approval was already used.',
  expired:'This preview expired. Ask again for a fresh preview.',
  credentials_revoked:'Your GitHub connection was removed or expired. Reconnect to continue.',
  quota_exhausted:'The AI usage limit for today was reached.',
  deploy_unverified:'Merged, but the live site does not match yet. Check again in a few minutes.',
  merge_blocked:'GitHub did not allow an automatic merge, so nothing was published. The pull request is open for you to review and merge.'
};
const SHA=/^[a-f0-9]{40}$/i, DIGEST=/^[a-f0-9]{64}$/i, ID=/^[a-f0-9]{32}$/i, CSRF=/^[A-Za-z0-9_-]{16,256}$/;
const TICKET=/^[A-Za-z0-9_-]{50,6000}$/;
// Canonical same-origin path only: no scheme, no '//' (protocol-relative), no dots, no trailing slash.
const ACTION=/^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const own=(o,k)=>typeof k==='string'&&Object.hasOwn(o,k);

function isAddedImage(edit){
  return /New image|new file/i.test(edit.replace||'') || (/\.(png|jpe?g|gif|webp)$/i.test(edit.path||'') && !/\.html?$/i.test(edit.path||''));
}

/** status: §4 status; code: optional §4 failure code; approve: {action, csrf} renders the approval form when status is 'previewed';
 * previewOrigin: the isolated preview origin, the only origin the preview link may point to. now: ms clock, for tests. */
export function editReviewMarkup({proposal,binding,status='previewed',code,approve,previewOrigin,ticket,now=Date.now()}={}){
  if(!Array.isArray(proposal?.edits)||!proposal.edits.every(e=>own(KINDS,e?.kind)&&[e.path,e.find,e.replace].every(v=>typeof v==='string'))
     ||!binding||!SHA.test(binding.baseCommitSha||'')||!DIGEST.test(binding.proposalDigest||'')||!DIGEST.test(binding.artifactDigest||'')
     ||!(own(TERMINAL,status)||STEPS.some(([s])=>s===status))||(code!=null&&!own(CODES,code))
     ||(binding.expiresAt!=null&&!(Number.isSafeInteger(binding.expiresAt)&&binding.expiresAt>0)))throw new TypeError('Unknown edit review shape');
  // Approval and preview only for a clean, unexpired preview; any failure code or terminal state fails closed.
  const live=status==='previewed'&&code==null&&Number.isSafeInteger(binding.expiresAt)&&binding.expiresAt*1000>now;
  const why=code??(status==='previewed'&&!live?'expired':null); // previewed but expired or missing expiry reads as expired
  let previewHref='';
  try{const u=new URL(binding.previewUrl);if(live&&u.protocol==='https:'&&u.origin===previewOrigin)previewHref=u.href;}catch{}
  const HEX=/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;
  // Swatch only for strict hex colors, so untrusted text never reaches the style attribute.
  const swatch=(e,v)=>e.kind==='css_color'&&HEX.test(v)?'<span class="er-swatch" style="background:'+v+'" aria-hidden="true"></span>':'';
  const change=e=>'<li class="er-change"><div class="er-meta"><span class="badge">'+KINDS[e.kind]+'</span> <code>'+escape(e.path)+'</code></div>'+
    '<div class="er-diff"><p class="er-old"><span class="lo-sr">Before: </span>'+swatch(e,e.find)+'<del>'+escape(e.find)+'</del></p><p class="er-new"><span class="lo-sr">After: </span>'+swatch(e,e.replace)+'<ins>'+escape(e.replace)+'</ins></p></div></li>';
  const visualOnly=proposal.edits.length>0&&proposal.edits.every(e=>e.kind==='page_snapshot');
  const visualRow=e=>{
    const label=isAddedImage(e)?'New image':'Updated page';
    return '<li class="er-file"><span class="badge">'+label+'</span> <code>'+escape(e.path)+'</code></li>';
  };
  const pages=visualOnly?proposal.edits.filter(e=>!isAddedImage(e)):[];
  const images=visualOnly?proposal.edits.filter(e=>isAddedImage(e)):[];
  const changesBlock=visualOnly
    ?('<h3>'+(live?'Files in this visual edit':'Files that were proposed')+' ('+proposal.edits.length+')</h3>'+
      (pages.length?'<p class="er-group-label">Pages</p><ul class="er-files" aria-label="Updated pages">'+pages.map(visualRow).join('')+'</ul>':'')+
      (images.length?'<p class="er-group-label">Images</p><ul class="er-files" aria-label="New images">'+images.map(visualRow).join('')+'</ul>':'')+
      '<p class="er-note">Open the exact preview to see the full page. This approval still binds only these files.</p>')
    :('<h3>'+(live?'What will change':'What was proposed')+' ('+proposal.edits.length+')</h3><ul class="er-changes">'+proposal.edits.map(change).join('')+'</ul>');
  const preview=previewHref
    ?'<p><a class="btn btn-secondary" href="'+escape(previewHref)+'" target="_blank" rel="noopener noreferrer">Open the exact preview</a></p><p class="er-note">Opens a private preview of exactly these files. Your live site is unchanged.</p>':'';
  const at=STEPS.findIndex(([s])=>s===status);
  const timeline='<ol class="er-steps" aria-label="Change progress">'+STEPS.map(([s,label],i)=>{
    const state=at<0?'':i<at||status==='live'?'is-done':i===at?'is-active':'';
    return '<li class="'+state+'"'+(state==='is-active'?' aria-current="step"':'')+'>'+label+'</li>';}).join('')+'</ol>';
  const problem=own(TERMINAL,status)||why!=null
    ?'<p role="alert"><strong>'+(own(TERMINAL,status)?TERMINAL[status]:'Needs attention')+'.</strong> '+(why!=null?CODES[why]:'Something went wrong. Nothing was published.')+'</p>':'';
  if(ticket!=null&&!TICKET.test(ticket))throw new TypeError('Unknown edit review shape');
  const canApprove=live&&ACTION.test(approve?.action||'')&&CSRF.test(approve?.csrf||'')&&ID.test(binding.approvalId||'');
  const form=canApprove
    ?'<form action="'+escape(approve.action)+'" method="POST"><input type="hidden" name="csrf" value="'+escape(approve.csrf)+'">'+
      (ticket?'<input type="hidden" name="ticket" value="'+escape(ticket)+'">':'')+
      '<input type="hidden" name="approvalId" value="'+escape(binding.approvalId)+'"><input type="hidden" name="proposalDigest" value="'+escape(binding.proposalDigest)+'">'+
      '<input type="hidden" name="artifactDigest" value="'+escape(binding.artifactDigest)+'">'+
      // Owner decision 2026-11-26: approving publishes (merges this exact change); a pull request stays available.
      '<button type="submit" name="action" value="publish">Approve and publish</button> '+
      '<button type="submit" name="action" value="pr" class="btn-secondary">Open a pull request instead</button></form>'+
      '<p class="er-note"><strong>Approve and publish</strong> commits exactly this change to your website\'s <code>main</code> branch and merges it, and Cloudflare Pages publishes it. Every other file stays the same. If your site changed since this preview, nothing is published. Want to review it in GitHub first? Choose <strong>Open a pull request instead</strong> and merge it yourself. This approval works once.</p>':'';
  const expires=Number.isSafeInteger(binding.expiresAt)?new Date(binding.expiresAt*1000).toISOString():'';
  return '<section class="er" aria-labelledby="er-title"><h2 id="er-title">'+(status==='previewed'?'Review this change':'Your change')+'</h2>'+
    '<p class="er-summary">'+escape(proposal.summary||'Proposed change')+'</p>'+problem+timeline+
    changesBlock+
    '<p class="muted">Every other file stays exactly the same.</p>'+preview+form+
    '<details><summary>Approval details</summary><ul class="er-facts"><li>Based on version <code>'+escape(binding.baseCommitSha.slice(0,12))+'</code></li>'+
    '<li>Preview fingerprint <code>'+escape(binding.artifactDigest.slice(0,12))+'…</code></li>'+
    (expires?'<li>Preview expires <time datetime="'+expires+'">'+expires.replace('T',' ').slice(0,16)+' UTC</time></li>':'')+'</ul></details></section>';
}
