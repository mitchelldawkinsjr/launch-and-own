import test from 'node:test';
import assert from 'node:assert/strict';
import {pageShell,stepperHtml} from './ui.mjs';
import {exploreMarkup,landingMarkup} from './landing.mjs';
import {aiUpdateJourneyMarkup} from './ai-update-journey.mjs';
import {harness} from './worker-test-support.mjs';

test('stepper marks active and completed steps without invented job percentages',()=>{
  const html=stepperHtml('preview');
  assert.match(html,/Step 3 of 5: Preview/);
  assert.match(html,/is-active[^>]*aria-current="step"/);
  assert.equal(html.match(/is-done/g).length,2);
  assert.doesNotMatch(html,/%/);
  assert.match(stepperHtml('launch',{complete:true}),/live and verified/);
});

test('page shell stays CSP-safe: no images, remote scripts, fonts, or trackers',()=>{
  const html=pageShell({title:'Welcome <x>',body:'<p>Describe it. Launch it. Own it.</p>',step:'connect'});
  assert.match(html,/Launch &amp; Own/);
  assert.match(html,/Welcome &lt;x&gt;/);
  assert.match(html,/href="#main"/);
  assert.doesNotMatch(html,/<(?:script|img|link)\b|cdn\.|fonts\.googleapis|googletagmanager/i);
});

test('landing leads with the outcome, keeps one panel open and links CTAs to the real setup',()=>{
  const html=landingMarkup({setupHtml:'<a href="/connect/github">Connect GitHub</a>'});
  assert.ok(html.indexOf('Your website.<br>Your rules.')<html.indexOf('id="explore"'));
  assert.ok(html.indexOf('id="explore"')<html.indexOf('id="get-started"'));
  assert.equal(html.match(/href="#get-started"/g).length,2);
  assert.equal(html.match(/name="lo-explore"/g).length,3);
  assert.equal(html.match(/ checked/g).length,1);
  assert.match(html,/id="lo-tab-launch" value="launch" checked/);
  assert.match(html,/Planned · not released/);
  assert.match(html,/<a href="\/connect\/github">Connect GitHub<\/a><\/section>/);
  assert.doesNotMatch(html,/<(?:script|img|iframe)\b|\bon[a-z]+=/i);
  assert.doesNotMatch(html,/Preview every page/);
  for(const zip of [true,false]){const page=landingMarkup({zipEnabled:zip});
    assert.doesNotMatch(page,/AI never approves|nothing is created until|professional website/,'copy review: no overclaims');
    assert.match(page,/No repository or hosting project is created until you approve/);}
});

test('ZIP-first copy follows only the strict verified flag and states compatibility limits',()=>{
  for(const off of [landingMarkup(),landingMarkup({zipEnabled:'true'})]){
    assert.doesNotMatch(off,/Build anywhere|Bring my website|Upload an existing ZIP|What kind of website can I bring/);
    assert.match(off,/Describe it\. Launch it\. Own it\./);
  }
  const on=landingMarkup({zipEnabled:true});
  assert.ok(on.indexOf('Build anywhere. Own everything.')<on.indexOf('id="explore"'));
  assert.equal(on.match(/>Bring my website</g).length,2);
  assert.match(on,/No site yet\? Create one/);
  assert.match(on,/Upload an existing ZIP/);
  assert.match(on,/Not supported yet<\/strong><ul><li>Unbuilt project source/);
  assert.match(on,/Up to 6 MB zipped, 128 files/);
  assert.match(on,/Launch &amp; Own editing for uploaded sites is not available yet/);
  assert.doesNotMatch(on,/limited editing/i);
  assert.doesNotMatch(on,/<p>[^<]*<div/,'block content must not sit inside <p>');
});

test('Maintain tab reuses #164 unchanged and marks the customer-owned assistant as planned',()=>{
  const html=exploreMarkup();
  assert.ok(html.includes(aiUpdateJourneyMarkup()));
  assert.match(html,/Planned · not released<\/span><h3>Your own website assistant/);
  assert.match(html,/Available with your own tools/);
  assert.doesNotMatch(html,/assistant is (?:available|live|released)/i);
  assert.ok(html.indexOf('lo-p-launch')<html.indexOf('lo-p-maintain')&&html.indexOf('lo-p-maintain')<html.indexOf('lo-p-grow'));
  assert.match(html,/Hosted beta\./);
});

test('signed-out landing renders through the Worker with security headers intact',async()=>{
 const h=harness();
 try{
  const res=await h.request('/');
  assert.equal(res.status,200);
  assert.match(res.headers.get('content-security-policy')||'',/default-src 'none'/);
  assert.equal(res.headers.get('x-frame-options'),'DENY');
  assert.equal(res.headers.get('cache-control'),'no-store');
  const html=await res.text();
  assert.match(html,/Your rules\./);
  assert.match(html,/id="get-started"[\s\S]*Connect GitHub/);
  assert.doesNotMatch(html,/<script/i);
 }finally{h.sqlite.close();}
});

test('error pages preserve Worker security response headers',async()=>{
 const h=harness();
 try{
  const res=await h.request('/missing-ui-route');
  assert.equal(res.status,404);
  assert.match(res.headers.get('content-security-policy')||'',/default-src 'none'/);
  assert.equal(res.headers.get('x-frame-options'),'DENY');
  assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('step'),null,'UI options must not leak into HTTP headers');
  assert.doesNotMatch(await res.text(),/Step 1 of 5/);
 }finally{h.sqlite.close();}
});
