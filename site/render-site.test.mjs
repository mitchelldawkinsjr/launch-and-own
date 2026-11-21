import test from "node:test";
import assert from "node:assert/strict";
import {renderSite,normalizeSite} from "./render-site.mjs";
const site={name:"Willow Studio",tagline:"Every detail matters",about:"Thoughtful portraits and creative events.",
 services:["Portrait photography","Event photography","Editing and retouching"],theme:"forest",contactEmail:"hello@willow.example"};
test("renders responsive semantic website with business copy, services and contact details",()=>{
 const html=renderSite(site);
 for(const expected of ["<!doctype html>","<html lang=\"en\">","<meta name=\"viewport\"","<main","id=\"services\"","id=\"about\"","id=\"contact\"","<nav aria-label=","Every detail matters","Portrait photography","Event photography","mailto:hello@willow.example"]){
  assert(html.includes(expected),expected);
 }
 assert(html.includes("--accent:#286247"));
 assert(!html.includes("<script"));
 assert(!html.includes("http://"));
});
test("normalization is deterministic and supplies safe defaults",()=>{
 const value=normalizeSite({name:"  New    Studio  "});
 assert.equal(value.name,"New Studio");
 assert.equal(value.theme,"ocean");
 assert.equal(value.services.length,0);
 assert.equal(renderSite({name:"New Studio"}),renderSite({name:"New Studio"}));
});
test("escapes HTML injection in all customer-authored text",()=>{
 const html=renderSite({name:'<script>alert("name")</script>',tagline:'<img src=x onerror=alert(1)>',
  about:'<a href="javascript:alert(1)">click</a>',services:["<svg onload=alert(1)>"]});
 assert(!html.includes("<script>alert"));
 assert(!html.includes("<img src=x"));
 assert(!html.includes("<svg onload"));
 assert(!html.includes("href=\"javascript:"));
 assert(html.includes("&lt;script&gt;"));
 assert(html.includes("&lt;img"));
});
test("contact address is strictly validated before being used in a mailto link",()=>{
 assert.throws(()=>renderSite({name:"Studio",contactEmail:'a@example.com" onclick="alert(1)'}),/valid contact email/);
 assert.throws(()=>renderSite({name:"Studio",contactEmail:"javascript:alert(1)"}),/valid contact email/);
});
test("rejects unsupported themes and oversize user input",()=>{
 for(const bad of [{theme:"../../../etc"},{tagline:"a".repeat(141)},{about:"x".repeat(651)},
  {services:Array.from({length:7},(_,i)=>"Service "+i)},{services:[42]},{contactEmail:"foo@invalid"}]){
  assert.throws(()=>normalizeSite({name:"Studio",...bad}));
 }
});
test("does not load external scripts, images or remote fonts",()=>{
 const html=renderSite(site);
 assert(!/<script\b/i.test(html));
 assert(!/<img\b/i.test(html));
 assert(!/@import/i.test(html));
 assert(!/https:\/\//i.test(html));
 assert.match(html,/Content-Security-Policy/);
});
