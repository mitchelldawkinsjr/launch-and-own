/** Review screen for a proposed edit to an imported site: changes, exact preview, single-use approval, status.
 * Renders contract §2 (proposal), §3 (binding) and §4 (status/codes) from docs/contracts/IMPORTED_SITE_CONTRACTS.md.
 * Presentation only. Not wired to a route until WS3 exists and M1.5 is authorized (#165/#171).
 * The server must verify proposal/binding identity and the changed-file mapping; nothing here is approval authority. */
import {escape} from './ui.mjs';

const KINDS={text:'Text',link:'Link',business_info:'Business details',css_color:'Color'};
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
  deploy_unverified:'Merged, but the live site does not match yet. Check again in a few minutes.'
};
const SHA=/^[a-f0-9]{40}$/i, DIGEST=/^[a-f0-9]{64}$/i, ID=/^[a-f0-9]{32}$/i, CSRF=/^[A-Za-z0-9_-]{16,256}$/;
// Canonical same-origin path only: no scheme, no '//' (protocol-relative), no dots, no trailing slash.
const ACTION=/^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const own=(o,k)=>typeof k==='string'&&Object.hasOwn(o,k);

/** status: §4 status; code: optional §4 failure code; approve: {action, csrf} renders the approval form when status is 'previewed';
 * previewOrigin: the isolated preview origin, the only origin the preview link may point to. now: ms clock, for tests. */
export function editReviewMarkup({proposal,binding,status='previewed',code,approve,previewOrigin,now=Date.now()}={}){
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
  const preview=previewHref
    ?'<p><a class="btn btn-secondary" href="'+escape(previewHref)+'" target="_blank" rel="noopener noreferrer">Open the exact preview</a></p><p class="er-note">Opens a private preview of exactly these files. Your live site is unchanged.</p>':'';
  const at=STEPS.findIndex(([s])=>s===status);
  const timeline='<ol class="er-steps" aria-label="Change progress">'+STEPS.map(([s,label],i)=>{
    const state=at<0?'':i<at||status==='live'?'is-done':i===at?'is-active':'';
    return '<li class="'+state+'"'+(state==='is-active'?' aria-current="step"':'')+'>'+label+'</li>';}).join('')+'</ol>';
  const problem=own(TERMINAL,status)||why!=null
    ?'<p role="alert"><strong>'+(own(TERMINAL,status)?TERMINAL[status]:'Needs attention')+'.</strong> '+(why!=null?CODES[why]:'Something went wrong. Nothing was published.')+'</p>':'';
  const canApprove=live&&ACTION.test(approve?.action||'')&&CSRF.test(approve?.csrf||'')&&ID.test(binding.approvalId||'');
  const form=canApprove
    ?'<form action="'+escape(approve.action)+'" method="POST"><input type="hidden" name="csrf" value="'+escape(approve.csrf)+'">'+
      '<input type="hidden" name="approvalId" value="'+escape(binding.approvalId)+'"><input type="hidden" name="proposalDigest" value="'+escape(binding.proposalDigest)+'">'+
      '<input type="hidden" name="artifactDigest" value="'+escape(binding.artifactDigest)+'"><button type="submit">Approve and open a pull request</button></form>'+
      '<p class="er-note">Approving creates a pull request in your GitHub account. <strong>Nothing goes live until you merge it.</strong> Launch &amp; Own never merges for you. This approval works once and expires in 15 minutes.</p>':'';
  const expires=Number.isSafeInteger(binding.expiresAt)?new Date(binding.expiresAt*1000).toISOString():'';
  return '<section class="er" aria-labelledby="er-title"><h2 id="er-title">Review this change</h2>'+
    '<p class="er-summary">'+escape(proposal.summary||'Proposed change')+'</p>'+problem+timeline+
    '<h3>'+(live?'What will change':'What was proposed')+' ('+proposal.edits.length+')</h3><ul class="er-changes">'+proposal.edits.map(change).join('')+'</ul>'+
    '<p class="muted">Every other file stays exactly the same.</p>'+preview+form+
    '<details><summary>Approval details</summary><ul class="er-facts"><li>Based on version <code>'+escape(binding.baseCommitSha.slice(0,12))+'</code></li>'+
    '<li>Preview fingerprint <code>'+escape(binding.artifactDigest.slice(0,12))+'…</code></li>'+
    (expires?'<li>Preview expires <time datetime="'+expires+'">'+expires.replace('T',' ').slice(0,16)+' UTC</time></li>':'')+'</ul></details></section>';
}
