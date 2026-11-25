import test from 'node:test';
import assert from 'node:assert/strict';
import {editReviewMarkup} from './edit-review.mjs';

const proposal={v:1,summary:'Update Saturday hours',edits:[{kind:'text',path:'public/index.html',find:'Saturday: 9 AM–2 PM',replace:'Saturday: 10 AM–4 PM'}]};
const binding={v:1,approvalId:'ab'.repeat(16),proposalDigest:'c'.repeat(64),artifactDigest:'d'.repeat(64),baseCommitSha:'e'.repeat(40),
  previewUrl:'https://abc.preview.example.test/',expiresAt:1764000000};
const approve={action:'/imported-edit/approve',csrf:'f00d'.repeat(8)};
const now=1764000000*1000-60_000, previewOrigin='https://abc.preview.example.test';
const base={proposal,binding,approve,now,previewOrigin};

test('previewed change shows before/after, exact preview, and a single-use bound approval form',()=>{
  const html=editReviewMarkup(base);
  assert.match(html,/<del>Saturday: 9 AM–2 PM<\/del>[\s\S]*<ins>Saturday: 10 AM–4 PM<\/ins>/);
  assert.match(html,/href="https:\/\/abc\.preview\.example\.test\/" target="_blank" rel="noopener noreferrer"/);
  for(const [k,v] of [['csrf',approve.csrf],['approvalId',binding.approvalId],['proposalDigest',binding.proposalDigest],['artifactDigest',binding.artifactDigest]])
    assert.match(html,new RegExp(`name="${k}" value="${v}"`));
  assert.match(html,/Nothing goes live until you merge it/);
  assert.match(html,/never merges for you/);
  assert.match(html,/aria-current="step">Preview ready/);
  assert.doesNotMatch(html,/<script|\bon[a-z]+=/i);
});

test('no approval form after approval, on failure, or with an unsafe action',()=>{
  assert.doesNotMatch(editReviewMarkup({...base,status:'pr_open'}),/<form/);
  for(const action of ['https://evil.test/x','//evil-test/approve','/a//b','/a/../b','/a/./b','/a/','/A','\\evil.test/x','/a?x=1','/a#x',' /a'])
    assert.doesNotMatch(editReviewMarkup({...base,approve:{...approve,action}}),/<form/,action);
  for(const csrf of [undefined,'','short','x"><b>'.repeat(4)])
    assert.doesNotMatch(editReviewMarkup({...base,approve:{...approve,csrf}}),/<form/,String(csrf));
  assert.doesNotMatch(editReviewMarkup({...base,binding:{...binding,approvalId:'nope'}}),/<form/);
  // A failure code with status previewed, or an expired/missing expiry, shows neither approval nor preview.
  for(const html of [editReviewMarkup({...base,code:'stale_base'}),editReviewMarkup({...base,now:1764000000*1000}),
    editReviewMarkup({...base,binding:{...binding,expiresAt:undefined}})]){
    assert.doesNotMatch(html,/<form|Open the exact preview|What will change/);
    assert.match(html,/role="alert"/);
  }
  assert.match(editReviewMarkup({...base,now:1764000000*1000}),/This preview expired/);
  const stale=editReviewMarkup({...base,status:'failed',code:'stale_base'});
  assert.match(stale,/role="alert"><strong>Stopped\.<\/strong> Your website files changed since this preview/);
  assert.doesNotMatch(stale,/<form|Open the exact preview|What will change/);
  assert.match(stale,/What was proposed/);
  assert.match(editReviewMarkup({proposal,binding,status:'live'}),/class="is-done">Live and checked/);
});

test('untrusted proposal text and preview URLs are escaped or dropped; bad shapes fail closed',()=>{
  const evil={...proposal,summary:'<img src=x onerror=1>',edits:[{kind:'text',path:'public/<b>.html',find:'</del><script>x</script>',replace:'"><svg onload=1>'}]};
  const html=editReviewMarkup({...base,proposal:evil,binding:{...binding,previewUrl:'javascript:alert(1)'}});
  assert.doesNotMatch(html,/<img|<script|<svg|javascript:/);
  assert.match(html,/&lt;\/del&gt;&lt;script&gt;/);
  assert.doesNotMatch(html,/Open the exact preview/);
  const css={proposal:{...proposal,edits:[{kind:'css_color',path:'public/style.css',find:'#2f6f5e',replace:'red;background:url(x)'}]},binding};
  const sw=editReviewMarkup(css);
  assert.equal((sw.match(/er-swatch/g)||[]).length,1,'swatch only for strict hex');
  assert.doesNotMatch(sw,/style="[^"]*url\(/);
  assert.throws(()=>editReviewMarkup({proposal,binding:{...binding,baseCommitSha:'x'}}),TypeError);
  assert.throws(()=>editReviewMarkup({proposal,binding,status:'mystery'}),TypeError);
  for(const bad of [{status:'constructor'},{status:'toString'},{code:'__proto__'},{code:'mystery'},{binding:{...binding,expiresAt:'soon'}},
    {binding:{...binding,expiresAt:-1}},{proposal:{...proposal,edits:[{...proposal.edits[0],kind:'hasOwnProperty'}]}},{proposal:{...proposal,edits:[{kind:'text'}]}}])
    assert.throws(()=>editReviewMarkup({...base,...bad}),TypeError,JSON.stringify(bad));
  // Preview link only on the isolated preview origin, never any other https URL.
  for(const previewUrl of ['https://evil.test/','https://abc.preview.example.test.evil.test/','http://abc.preview.example.test/'])
    assert.doesNotMatch(editReviewMarkup({...base,binding:{...binding,previewUrl}}),/Open the exact preview/,previewUrl);
  assert.doesNotMatch(editReviewMarkup({...base,previewOrigin:undefined}),/Open the exact preview/);
});
