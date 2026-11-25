import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceExplorerMarkup} from './service-explorer.mjs';
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
  assert.match(html,/id="lo-tab-launch"[^>]*aria-label="Launch: Get your business online" checked>/);
  assert.equal(html.match(/class="lo-tab-(?:label|hint)" aria-hidden="true"/g).length,6,'tab text announced once, via the radio name');
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

test('Maintain explains how the planned assistant would work, matching the approved contract and design (#165, #170)',()=>{
  const html=exploreMarkup();
  const maintain=html.slice(html.indexOf('lo-p-maintain'),html.indexOf('lo-p-grow'));
  assert.match(maintain,/How the planned assistant would work/);
  assert.deepEqual([...maintain.matchAll(/<li><span class="lo-asst-n" aria-hidden="true">\d<\/span><div><strong>([^<]+)</g)].map(m=>m[1]),
    ['Ask','Prepare','Preview','Approve','You merge','Publish and check']);
  assert.match(maintain,/works once and expires after 15 minutes/,'contract: 15-minute single-use approval');
  assert.match(maintain,/Up to 10 changes in up to 5 files/,'contract: edit limits');
  assert.match(maintain,/text, links, business details[^<]*colors/,'contract: edit kinds');
  assert.match(maintain,/set up in your own GitHub and Cloudflare accounts/,'ADR-001: customer-run setup');
  assert.match(maintain,/Only you can merge it/);
  assert.match(maintain,/cannot merge them/);
  assert.doesNotMatch(maintain,/will (?:merge|publish) for you|automatically (?:merge|publish)/i);
});

test('Grow lists the planned assistant resources as planned, created only by the owner, never as active',()=>{
  const html=exploreMarkup();
  const grow=html.slice(html.indexOf('lo-p-grow'));
  assert.ok(grow.includes(serviceExplorerMarkup()),'shared explorer unchanged');
  assert.match(grow,/04 · Your private website assistant<\/h3><span>Planned · not released · created only by you/);
  const cards=[...grow.matchAll(/<strong>([^<]+)<\/strong><small>(GitHub|Cloudflare) · planned<\/small>/g)].map(m=>m[1]);
  assert.deepEqual(cards,['Assistant repository','Private GitHub app','Workers','D1 database','Workers AI','Access']);
  assert.match(grow,/Nothing here exists yet, and exploring creates nothing/);
  assert.match(grow,/separate from the Workers, D1 and Access a contact form uses/);
  assert.match(grow,/paid plans the provider bills you directly/);
  assert.doesNotMatch(grow.slice(grow.indexOf('04 · Your private')),/>(?:Active|Included|Available)<|free forever|guaranteed/i);
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
test('GitHub, Cloudflare and pages.dev links open in a new tab; app links stay in place', async () => {
  const {providerLinksInNewTab} = await import('./ui.mjs');
  const out = providerLinksInNewTab('<a href="https://github.com/tester/repo">Open on GitHub</a>'+
    '<a href="https://dash.cloudflare.com/a/workers-and-pages" rel="noreferrer">Open in Cloudflare</a>'+
    '<a href="https://esp-x-site.pages.dev/">site</a><a href="/history">Your launches</a>'+
    '<a href="https://github.com.evil.example/x">fake</a><a href="https://github.com/p" target="_self">kept</a>'+
    '<a href="https://github.com/q" target="_blank" rel="noopener">Open (new tab)</a>');
  assert.match(out, /<a href="https:\/\/github\.com\/tester\/repo" target="_blank" rel="noopener noreferrer">Open on GitHub<span class="lo-sr"> \(opens in a new tab\)<\/span><\/a>/);
  assert.match(out, /<a href="https:\/\/dash\.cloudflare\.com\/a\/workers-and-pages" rel="noreferrer" target="_blank">Open in Cloudflare<span class="lo-sr">/);
  assert.match(out, /pages\.dev\/" target="_blank"/);
  assert.match(out, /<a href="\/history">Your launches<\/a>/);
  assert.match(out, /<a href="https:\/\/github\.com\.evil\.example\/x">fake<\/a>/);
  assert.match(out, /target="_self">kept<\/a>/);
  assert.equal((out.match(/opens in a new tab/g) || []).length, 3);
});
