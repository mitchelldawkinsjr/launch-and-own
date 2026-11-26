import test from "node:test";
import assert from "node:assert/strict";
import {SITE_DRAFT_SCHEMA,aiDraftConfigured,draftSiteFromBrief} from "./draft-site.mjs";
import {renderSite} from "./render-site.mjs";

const brief={
 name:"Willow Studio",
 description:"Willow Studio provides family portraits, event photography, and photo retouching in our local community.",
 theme:"forest",
 contactEmail:"hello@willow.example"
};
const example={
 tagline:"Thoughtful moments, beautifully photographed",
 about:"Willow Studio offers family portraits, event photography, and retouching.",
 services:["Family portraits","Event photography","Photo retouching"]
};
const model="@cf/meta/llama-3.1-8b-instruct";

test("models are invoked only with an explicitly supplied human business brief",async()=>{
 let invocations=0;
 const ai={run:async(name,request)=>{
   invocations++;
   assert.equal(name,model);
   assert.equal(request.response_format.type,"json_schema");
   assert.deepEqual(request.response_format.json_schema,SITE_DRAFT_SCHEMA);
   assert.match(request.messages[1].content,/Willow Studio/);
   assert(!request.messages[1].content.includes("hello@willow.example"),"Email is never sent to the model");
   assert(!JSON.stringify(request).includes("TOKEN_ENCRYPTION_KEY"));
   assert.equal(request.stream,false);
   return {response:JSON.stringify(example)};
 }};
 const result=await draftSiteFromBrief({ai,model,...brief});
 assert.equal(invocations,1);
 assert.equal(result.name,brief.name);
 assert.equal(result.contactEmail,brief.contactEmail);
 assert.equal(result.theme,"forest");
 assert.deepEqual(result.services,example.services);
 assert.match(renderSite(result),/Thoughtful moments, beautifully photographed/);
});
test("model output can be an already-parsed object; user-owned fields cannot be overwritten",async()=>{
 const ai={run:async()=>({response:{...example,name:"Impersonated",theme:"graphite",contactEmail:"intruder@example.com",script:"<script>alert(1)</script>"}})};
 const output=await draftSiteFromBrief({ai,model,...brief});
 assert.equal(output.name,"Willow Studio");
 assert.equal(output.theme,"forest");
 assert.equal(output.contactEmail,"hello@willow.example");
 assert.equal(output.script,undefined);
});
test("no AI binding/model means feature is unavailable, with no provider invocation",async()=>{
 let calls=0;const ai={run:async()=>{calls++;return example}};
 assert.equal(aiDraftConfigured({AI:ai}),false);
 assert.equal(aiDraftConfigured({AI:ai,SITE_AI_MODEL:model}),true);
 assert.equal(aiDraftConfigured({AI:ai,SITE_AI_MODEL:"malicious"}),false);
 await assert.rejects(draftSiteFromBrief({...brief,model:"bad",ai}),/not configured/);
 assert.equal(calls,0);
});
test("business brief is bounded and verified before any model request",async()=>{
 let calls=0;const ai={run:async()=>{calls++;return {response:example}}};
 for(const bad of [{description:"too short"},{description:"x".repeat(1401)},{name:""},{theme:"<script>"},{contactEmail:"javascript:alert(1)"}])
  await assert.rejects(draftSiteFromBrief({ai,model,...brief,...bad}));
 assert.equal(calls,0);
});
test("model-provided HTML is escaped and never executed in the preview",async()=>{
 const ai={run:async()=>({response:{tagline:'<script>alert("XSS")</script>',about:'<svg onload=alert(1)>',services:["<img src=x onerror=alert(1)>"]}})};
 const result=await draftSiteFromBrief({ai,model,...brief});
 const html=renderSite(result);
 assert(!html.includes("<script>alert"));
 assert(!html.includes("<svg onload"));
 assert(!html.includes("<img src=x onerror"));
 assert(html.includes("&lt;script&gt;"));
});
test("malformed, overlong and incomplete model results are rejected",async()=>{
 const cases=[
   "this is not JSON",
   "x".repeat(6001),
   JSON.stringify({tagline:"fine",about:"missing services"}),
   {response:{tagline:"x".repeat(141),about:"valid",services:[]}},
   {response:{tagline:"fine",about:"valid",services:Array(7).fill("service")}},
   {response:{tagline:"fine",about:"valid",services:[99]}},
   {response:null}
 ];
 for(const answer of cases){
   const ai={run:async()=>answer};
   await assert.rejects(draftSiteFromBrief({ai,model,...brief}));
 }
});
test("provider failures are reduced to safe user-friendly messages",async()=>{
 const ai={run:async()=>{throw Error("provider private secret token detail")}};
 await assert.rejects(draftSiteFromBrief({ai,model,...brief}),e=>{
   assert.match(e.message,/temporarily unavailable/);
   assert(!e.message.includes("secret"));
   return true;
 });
});
test("AI-generated copy is only a draft: renderer does not create scripts or embedded forms",async()=>{
 const ai={run:async()=>({response:example})};
 const result=await draftSiteFromBrief({ai,model,...brief});
 const html=renderSite(result);
 assert(!/<script\b/i.test(html));
 assert(!/<form\b/i.test(html));
 // Only the Cloudflare Web Analytics origins in the CSP, no other remote address.
 assert(!/https:\/\/[^\s"']+/i.test(html.replace(/script-src https:\/\/static\.cloudflareinsights\.com; connect-src &#39;self&#39; https:\/\/cloudflareinsights\.com; /,"")));
});
