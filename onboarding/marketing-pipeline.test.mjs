import test from 'node:test';
import assert from 'node:assert/strict';
import {marketingPipelineCss,marketingPipelineMarkup} from './marketing-pipeline.mjs';

test('marketing visual explains the account-to-publication flow without implying publication happened',()=>{
 const html=marketingPipelineMarkup();
 const order=['Bring your idea','Launch &amp; Own</h3>','GitHub</h3>','Cloudflare Pages</h3>','Your website</h3>'].map(s=>html.indexOf(s));
 assert.ok(order.every((n,i)=>n>=0&&(i===0||n>order[i-1])));
 for(const phrase of ['private preview','Nothing publishes without your approval','separate Cloudflare Workers &amp; Pages GitHub app','Hosted beta','subject to plan and usage limits']) assert.ok(html.includes(phrase));
 assert.doesNotMatch(html,/<(?:script|form|iframe|img)\b|\bhref=|\bonclick=/i);
 assert.match(marketingPipelineCss,/@media\(max-width:940px\)/);
});
test('ZIP path follows only the strict verified feature flag',()=>{
 assert.doesNotMatch(marketingPipelineMarkup(),/Upload an existing ZIP/);
 assert.doesNotMatch(marketingPipelineMarkup({zipEnabled:'true'}),/Upload an existing ZIP/);
 assert.match(marketingPipelineMarkup({zipEnabled:true}),/Upload an existing ZIP/);
});
