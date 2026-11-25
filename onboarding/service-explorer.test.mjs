import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {serviceExplorerMarkup,serviceExplorerCss} from './service-explorer.mjs';
import {marketingPipelineMarkup} from './marketing-pipeline.mjs';
import {renderToolkitPage} from './post-launch-toolkit.mjs';

test('prelaunch explorer contains all ten technologies, examples and no provider actions',()=>{
 const html=serviceExplorerMarkup();
 for(const name of ['GitHub','Cloudflare Pages','D1','Workers','Turnstile','Web Analytics','Cloudflare DNS','Email Routing','Cloudflare Access','R2']) assert.ok(html.includes('<strong>'+name+'</strong>'),name);
 assert.equal((html.match(/<details class="sx-card/g)||[]).length,10);
 assert.match(html,/No optional resources are created/);
 assert.match(html,/separate customer-owned database/);
 assert.doesNotMatch(html,/<(?:script|form|iframe|img)\\b|\\bhref=|\\bonclick=|Verified active/i);
 assert.ok(marketingPipelineMarkup().includes(html));
 assert.match(serviceExplorerCss,/focus-visible/);
});
test('toolkit displays recorded capability states, never infers individual resources',()=>{
 const html=serviceExplorerMarkup({mode:'toolkit',capabilities:{static_hosting:{state:'included_verified',detail:'Recorded hosting'},web_analytics:{state:'active_verified',detail:'<script>alert(1)</script>'},contact_forms:{state:'active_verified',detail:'Form active'}}});
 assert.match(html,/Included in recorded launch/);
 assert.match(html,/Verified active/);
 assert.match(html,/&lt;script&gt;alert\\(1\\)&lt;\\/script&gt;/);
 assert.doesNotMatch(html,/<script>|Form active/);
 assert.equal((html.match(/Verified active/g)||[]).length,1);
 assert.match(html,/Individual status not verified/);
 assert.match(html,/Future extension/);
 assert.doesNotMatch(serviceExplorerMarkup({mode:'toolkit'}),/Verified active|Included in recorded launch/);
 assert.throws(()=>serviceExplorerMarkup({mode:'fake'}),/Unknown/);
});
test('standalone preview contains the exact shared pre-launch and demo markup',()=>{
 const preview=readFileSync(new URL('../docs/marketing-pipeline-preview.html',import.meta.url),'utf8');
 assert.ok(preview.includes(serviceExplorerMarkup()));
 assert.ok(preview.includes(serviceExplorerMarkup({mode:'demo'})));
 assert.match(preview,/Toolkit design preview — no real account/);
});
test('toolkit renders explorer only within supplied owner-scoped cards',()=>{
 const view=(_title,body)=>body;
 const escape=s=>String(s);
 const card={name:'Example site',statusLabel:'Recorded',statusDetail:'Test',capabilities:{static_hosting:{state:'included_verified',detail:'Recorded hosting'}}};
 assert.doesNotMatch(renderToolkitPage([card],null,{view,escape}),/Explore your website services/);
 assert.doesNotMatch(renderToolkitPage([],{cloudflare_account_id:'test'},{view,escape}),/Explore your website services/);
 const html=renderToolkitPage([card],{cloudflare_account_id:'test'},{view,escape});
 assert.match(html,/Explore your website services/);
 assert.ok(html.includes(serviceExplorerMarkup({mode:'toolkit',capabilities:card.capabilities})));
});
