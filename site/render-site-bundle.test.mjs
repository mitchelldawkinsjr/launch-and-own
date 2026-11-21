import test from "node:test";
import assert from "node:assert/strict";
import {BUNDLE_PATHS,renderSiteBundle} from "./render-site-bundle.mjs";

const input={name:"Willow Studio",tagline:"Every moment matters",
  about:"Portrait photography for families and community events.",
  services:["Family portraits","Community celebrations","Photo retouching"],
  theme:"forest",contactEmail:"hello@willow.example",layout:"multi-page"};
test("creates four deterministic HTML documents with clean Pages routes",()=>{
 const bundle=renderSiteBundle(input);
 assert.equal(bundle.mode,"multi-page");
 assert.equal(bundle.pageCount,4);
 assert.deepEqual(bundle.pages.map(p=>p.path),BUNDLE_PATHS);
 assert.deepEqual(bundle,renderSiteBundle(input));
 for(const doc of bundle.pages){
   assert.match(doc.html,/<!doctype html>/i);
   assert.match(doc.html,/<html lang="en">/);
   assert.match(doc.html,/<main id="main">/);
   assert.match(doc.html,/Skip to content/);
   assert.match(doc.html,/aria-label="Main navigation"/);
   assert.match(doc.html,/<title>[^<]*Willow Studio<\/title>/);
   assert.match(doc.html,/--accent:#286247/);
   for(const href of ['"/"','"/about/"','"/services/"','"/contact/"'])
     assert(doc.html.includes("href="+href),doc.path+" missing "+href);
   assert.equal((doc.html.match(/aria-current="page"/g)||[]).length,1);
 }
});
test("services and contact are fully owned by the customer's validated data",()=>{
 const docs=renderSiteBundle(input).pages;
 assert.match(docs[2].html,/Family portraits/);
 assert.match(docs[2].html,/Community celebrations/);
 assert.match(docs[2].html,/Photo retouching/);
 assert.match(docs[3].html,/mailto:hello@willow.example/);
 assert(!docs[3].html.includes("<form"));
});
test("script injection in business copy is escaped in every rendered page",()=>{
 const docs=renderSiteBundle({...input,name:"<img src=x onerror=alert(1)>",
  tagline:"<script>alert(1)</script>",about:'<svg onload="malicious()">',
  services:['<a href="javascript:alert(1)">click</a>']}).pages;
 for(const {html} of docs){
   assert(!html.includes("<script>alert"));
   assert(!html.includes("<img src=x"));
   assert(!html.includes("<svg onload"));
   assert(!html.includes('href="javascript:'));
   assert(!/<script\b/i.test(html));
   assert(html.includes("&lt;img"));
 }
});
test("does not use third-party scripts, fonts, images, forms or trackers",()=>{
 for(const {html} of renderSiteBundle(input).pages){
   assert(!/<script\b|<img\b|<form\b|<iframe\b/i.test(html));
   assert(!/@import|fetch\(|google-analytics|http:\/\//i.test(html));
   assert(!/https:\/\//i.test(html));
   assert.match(html,/Content-Security-Policy/);
 }
});
test("empty contact email produces no broken mailto links",()=>{
 const pages=renderSiteBundle({name:"Quiet Studio",layout:"multi-page"}).pages;
 assert(!pages.some(x=>x.html.includes("mailto:")));
 assert.match(pages[3].html,/Contact details can be added/);
});
test("invalid site, theme, business name and layout reject early",()=>{
 for(const bad of [{...input,layout:"../private"},{...input,theme:"red"},
   {...input,contactEmail:"javascript:alert(1)"},{...input,name:""},
   {...input,services:["x".repeat(86)]}]){
   assert.throws(()=>renderSiteBundle(bad));
 }
});
test("multi-page bundles are immutable to avoid output mutation between preview and publish",()=>{
 const bundle=renderSiteBundle(input);
 assert(Object.isFrozen(bundle.pages));
 for(const item of bundle.pages)assert(Object.isFrozen(item));
});
