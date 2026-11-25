import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {aiUpdateJourneyMarkup,aiUpdateJourneyCss} from './ai-update-journey.mjs';
import {marketingPipelineMarkup,marketingPipelineCss} from './marketing-pipeline.mjs';
test('AI marketing journey shows the owner-controlled independent workflow',()=>{
 const html=aiUpdateJourneyMarkup();
 for(const phrase of ['ChatGPT + Codex','Claude Code','GitHub pull request','Compare with the current website','You merge. Cloudflare deploys.','automatic production builds enabled','after a successful build','Awaiting your review','not a live demo','not enough to push code','does not enable those builds by default','Preview URLs may be public']) assert.ok(html.includes(phrase),phrase);
 const order=['01 · Ask','02 · Propose','03 · Review','04 · Publish'].map(s=>html.indexOf(s));
 assert.ok(order.every((n,i)=>n>=0&&(!i||n>order[i-1])));
 assert.doesNotMatch(html,/<(?:script|form|iframe|img)\b|\bhref=|\bonclick=/i);
 assert.match(aiUpdateJourneyCss,/focus-visible/);
});
test('landing and offline preview share the exact AI illustration',()=>{
 const html=marketingPipelineMarkup();
 const demo=aiUpdateJourneyMarkup();
 assert.ok(html.includes(demo));
 assert.ok(html.indexOf(demo)<html.indexOf('Explore your digital ecosystem'));
 assert.ok(marketingPipelineCss.includes(aiUpdateJourneyCss));
 const preview=readFileSync(new URL('../docs/marketing-pipeline-preview.html',import.meta.url),'utf8');
 assert.ok(preview.includes(demo));
});
