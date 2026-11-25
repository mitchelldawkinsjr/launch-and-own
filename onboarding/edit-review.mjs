/** Review screen for a proposed edit to an imported site: changes, exact preview, single-use approval, status.
 * Renders contract §2 (proposal), §3 (binding) and §4 (status/codes) from docs/contracts/IMPORTED_SITE_CONTRACTS.md.
 * Presentation only. Not wired to a route until WS3 exists and M1.5 is authorized (#165/#171). */
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
const SHA=/^[a-f0-9]{40}$/i, DIGEST=/^[a-f0-9]{64}$/i, ID=/^[a-f0-9]{32}$/i;

/** status: §4 status; code: optional §4 failure code; approve: {action, csrf} renders the approval form when status is 'previewed'. */
export function editReviewMarkup({proposal,binding,status='previewed',code,approve}={}){
  if(!Array.isArray(proposal?.edits)||!binding||!SHA.test(binding.baseCommitSha||'')||!DIGEST.test(binding.proposalDigest||'')||!DIGEST.test(binding.artifactDigest||'')
     ||!(status in TERMINAL||STEPS.some(([s])=>s===status)))throw new TypeError('Unknown edit review shape');
  const HEX=/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;
  // Swatch only for strict hex colors, so untrusted text never reaches the style attribute.
  const swatch=(e,v)=>e.kind==='css_color'&&HEX.test(v)?'<span class="er-swatch" style="background:'+v+'" aria-hidden="true"></span>':'';
  const change=e=>'<li class="er-change"><div class="er-meta"><span class="badge">'+(KINDS[e.kind]||'Change')+'</span> <code>'+escape(e.path)+'</code></div>'+
    '<div class="er-diff"><p class="er-old"><span class="lo-sr">Before: </span>'+swatch(e,e.find)+'<del>'+escape(e.find)+'</del></p><p class="er-new"><span class="lo-sr">After: </span>'+swatch(e,e.replace)+'<ins>'+escape(e.replace)+'</ins></p></div></li>';
  const preview=status==='previewed'&&/^https:\/\//.test(binding.previewUrl||'')
    ?'<p><a class="btn btn-secondary" href="'+escape(binding.previewUrl)+'" target="_blank" rel="noopener noreferrer">Open the exact preview</a></p><p class="er-note">Opens a private preview of exactly these files. Your live site is unchanged.</p>':'';
  const at=STEPS.findIndex(([s])=>s===status);
  const timeline='<ol class="er-steps" aria-label="Change progress">'+STEPS.map(([s,label],i)=>{
    const state=at<0?'':i<at||status==='live'?'is-done':i===at?'is-active':'';
    return '<li class="'+state+'"'+(state==='is-active'?' aria-current="step"':'')+'>'+label+'</li>';}).join('')+'</ol>';
  const problem=status in TERMINAL||code
    ?'<p role="alert"><strong>'+(TERMINAL[status]||'Needs attention')+'.</strong> '+(CODES[code]||'Something went wrong. Nothing was published.')+'</p>':'';
  const canApprove=status==='previewed'&&/^\/[a-z0-9/-]*$/.test(approve?.action||'')&&ID.test(binding.approvalId||'');
  const form=canApprove
    ?'<form action="'+escape(approve.action)+'" method="POST"><input type="hidden" name="csrf" value="'+escape(approve.csrf)+'">'+
      '<input type="hidden" name="approvalId" value="'+escape(binding.approvalId)+'"><input type="hidden" name="proposalDigest" value="'+escape(binding.proposalDigest)+'">'+
      '<input type="hidden" name="artifactDigest" value="'+escape(binding.artifactDigest)+'"><button type="submit">Approve and open a pull request</button></form>'+
      '<p class="er-note">Approving creates a pull request in your GitHub account. <strong>Nothing goes live until you merge it.</strong> Launch &amp; Own never merges for you. This approval works once and expires in 15 minutes.</p>':'';
  const expires=Number.isSafeInteger(binding.expiresAt)?new Date(binding.expiresAt*1000).toISOString():'';
  return '<section class="er" aria-labelledby="er-title"><h2 id="er-title">Review this change</h2>'+
    '<p class="er-summary">'+escape(proposal.summary||'Proposed change')+'</p>'+problem+timeline+
    '<h3>'+(status==='previewed'?'What will change':'What was proposed')+' ('+proposal.edits.length+')</h3><ul class="er-changes">'+proposal.edits.map(change).join('')+'</ul>'+
    '<p class="muted">Every other file stays exactly the same.</p>'+preview+form+
    '<details><summary>Approval details</summary><ul class="er-facts"><li>Based on version <code>'+escape(binding.baseCommitSha.slice(0,12))+'</code></li>'+
    '<li>Preview fingerprint <code>'+escape(binding.artifactDigest.slice(0,12))+'…</code></li>'+
    (expires?'<li>Preview expires <time datetime="'+expires+'">'+expires.replace('T',' ').slice(0,16)+' UTC</time></li>':'')+'</ul></details></section>';
}
