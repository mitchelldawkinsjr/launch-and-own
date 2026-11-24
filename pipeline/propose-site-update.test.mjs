import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {previewWebsiteUpdate,proposeWebsiteUpdate} from "./propose-site-update.mjs";
import {managedRepositoryDescription} from "./managed-site-repository.mjs";
import {renderSite} from "../site/render-site.mjs";

const BASE_SHA="a".repeat(40),UPDATE_SHA="b".repeat(40),BLOB_SHA="c".repeat(40);
const owner="tester",name="Willow Studio",repoName="esp-willow-studio";
const root="/repos/"+owner+"/"+repoName;
const oldHtml=renderSite({name,tagline:"Old website headline"});
const input={name,githubOwner:owner,accountId:"0123456789abcdef0123456789abcdef",
  site:{tagline:"Brand new website headline",about:"Local family portraits and photography.",
    services:["Portraits","Events"],theme:"forest"}};
const blobSha=html=>createHash('sha1').update('blob '+Buffer.byteLength(html)+'\0').update(html).digest('hex');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});

function harness(options={}){
 const state={currentHtml:options.currentHtml??oldHtml,mainSha:options.mainSha??BASE_SHA,
   repo:{id:101,name:repoName,private:true,default_branch:"main",
    description:options.unmanaged?"Somebody else's repo":"Launch & Own managed site: willow-studio",
    owner:{login:options.otherOwner?"someone-else":owner,id:42}},
   branch:null,branchSha:null,branchHtml:null,prs:[],createdRefs:0,updates:0,prsCreated:0,
   failUpdateOnce:false};
 const history=[];
 const fetchFn=async(url,opts={})=>{
   const u=new URL(url),method=opts.method||"GET",path=decodeURIComponent(u.pathname);
   history.push({method,path,query:u.search});
   const payload=opts.body?JSON.parse(opts.body):null;
   if(u.hostname!=="api.github.com")throw Error("Wrong provider: "+u.hostname);
   if(path==="/user"&&method==="GET")return json({login:options.otherOwner?"someone-else":owner,id:42});
   if(path===root&&method==="GET")return json(state.repo);
   if(path===root+"/branches/main"&&method==="GET")return json({commit:{sha:state.mainSha}});
   if(path===root+"/contents/public/index.html"&&method==="GET"){
     const ref=u.searchParams.get("ref");
     if(ref===state.mainSha)return json({type:"file",sha:BLOB_SHA,encoding:"base64",
       content:Buffer.from(state.currentHtml).toString("base64")});
     if(ref===state.branch)return json({type:"file",sha:BLOB_SHA,encoding:"base64",
       content:Buffer.from(state.branchHtml).toString("base64")});
     return json({message:"not found"},404);
   }
   if(path.startsWith(root+"/branches/")&&method==="GET"){
     const branch=path.slice((root+"/branches/").length);
     return state.branch===branch?json({name:branch,commit:{sha:state.branchSha}}):json({},404);
   }
   if(path===root+"/git/refs"&&method==="POST"){
     assert.equal(payload.sha,BASE_SHA);
     assert(payload.ref.startsWith("refs/heads/launch-and-own/site-"));
     state.branch=payload.ref.slice("refs/heads/".length);
     state.branchSha=BASE_SHA;state.branchHtml=state.currentHtml;state.createdRefs++;
     return json({ref:payload.ref},201);
   }
   if(path===root+"/contents/public/index.html"&&method==="PUT"){
     assert.equal(payload.branch,state.branch);
     assert.equal(payload.sha,BLOB_SHA);
     if(state.failUpdateOnce){state.failUpdateOnce=false;return json({},503);}
     state.branchHtml=Buffer.from(payload.content,"base64").toString("utf8");
     state.branchSha=UPDATE_SHA;state.updates++;
     return json({commit:{sha:UPDATE_SHA}},200);
   }
   if(path===root+"/commits/"+UPDATE_SHA&&method==="GET"){
     const files=[{filename:"public/index.html",status:"modified",sha:blobSha(state.branchHtml)}];
     if(state.extraFile)files.push({filename:"public/unreviewed.html",status:"added",sha:BLOB_SHA});
     return json({sha:UPDATE_SHA,parents:[{sha:state.updateParent??BASE_SHA}],files});
   }
   if(path===root+"/pulls"&&method==="GET"){
     assert.equal(u.searchParams.get("base"),"main");
     assert.equal(u.searchParams.get("state"),"all");
     return json(state.prs);
   }
   if(path===root+"/pulls"&&method==="POST"){
     assert.equal(payload.head,state.branch);assert.equal(payload.base,"main");
     assert.match(payload.body,/Approval preview SHA-256/);
     const item={number:55,state:"open",html_url:"https://github.com/"+owner+"/"+repoName+"/pull/55",
       head:{ref:state.branch,sha:state.branchSha,repo:{id:state.repo.id}},
       base:{ref:"main",sha:state.mainSha,repo:{id:state.repo.id}}};
     state.prs.push(item);state.prsCreated++;
     return json(item,201);
   }
   throw Error("Unexpected GitHub request "+method+" "+path);
 };
 return {state,history,fetchFn};
}
const auth={githubToken:"ghu_secret_placeholder"};
async function approvedInput(){const preview=await previewWebsiteUpdate(input);return {
 ...input,explicitlyApproved:true,expectedBaseCommitSha:BASE_SHA,approvedHtmlSha256:preview.htmlSha256
};}
test("read-only update preview exposes exact stable HTML hash without GitHub requests",async()=>{
 const preview=await previewWebsiteUpdate(input);
 assert.equal(preview.status,"preview-only");
 assert.match(preview.html,/Brand new website headline/);
 assert.equal(preview.htmlSha256.length,64);
 assert.equal((await previewWebsiteUpdate(input)).htmlSha256,preview.htmlSha256);
});
test("an unapproved, stale or mismatched preview makes no network or provider mutations",async()=>{
 const h=harness();const original=await approvedInput();
 for(const changed of [
   {...original,explicitlyApproved:false},
   {...original,approvedHtmlSha256:"f".repeat(64)},
   {...original,site:{tagline:"Different content"}},
   {...original,expectedBaseCommitSha:"invalid"}
 ]){
   await assert.rejects(proposeWebsiteUpdate(changed,{...auth,fetchFn:h.fetchFn}));
 }
 assert.equal(h.history.length,0);
});
test("customer-approved update makes only a GitHub feature branch plus reviewable PR",async()=>{
 const h=harness();const approved=await approvedInput();
 const r=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(r.status,"awaiting-customer-merge");
 assert.equal(r.number,55);assert.equal(r.reused,false);
 assert.equal(r.headCommitSha,UPDATE_SHA);
 assert.equal(r.pullRequest,"https://github.com/tester/esp-willow-studio/pull/55");
 assert.equal(h.state.createdRefs,1);assert.equal(h.state.updates,1);assert.equal(h.state.prsCreated,1);
 assert.equal(h.state.currentHtml,oldHtml,"The live main branch must not change");
 assert.equal(h.state.branchHtml,renderSite({...input.site,name}));
 assert(h.history.every(x=>x.method!=="DELETE"));
 assert(!h.history.some(x=>x.method==="PUT"&&x.path.includes("/branches/main")));
 assert(!JSON.stringify(r).includes("ghu_secret_placeholder"));
});
test("safe retry reuses the same update branch and PR without duplicate writes",async()=>{
 const h=harness();const approved=await approvedInput();
 const first=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 const updates=h.state.updates;
 const second=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(second.pullRequest,first.pullRequest);
 assert.equal(second.reused,true);
 assert.equal(h.state.updates,updates);
 assert.equal(h.state.createdRefs,1);assert.equal(h.state.prsCreated,1);
});
test("approved updates accept a valid durable launch marker for the same slug",async()=>{
 const h=harness(),approved=await approvedInput();
 const jobId="911f8789-0a1b-4e8b-8b4b-3757536425c3";
 h.state.repo.description=managedRepositoryDescription("other-site",jobId);
 await assert.rejects(proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn}),/managed resource/);
 assert(h.history.every(call=>call.method==="GET"));
 h.state.repo.description=managedRepositoryDescription("willow-studio",jobId);
 const result=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(result.status,"awaiting-customer-merge");
 assert.equal(h.state.currentHtml,oldHtml);
});
test("a replaced GitHub repository with the same slug/owner cannot receive an approved edit",async()=>{
 const h=harness(),approved={...await approvedInput(),expectedRepositoryId:101};
 h.state.repo.id=102;
 await assert.rejects(proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn}),/repository identity changed/);
 assert(h.history.every(x=>x.method==="GET"));
 assert.equal(h.state.prsCreated,0);
 h.state.repo.id=101;
 const valid=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(valid.status,"awaiting-customer-merge");
});
test("unmanaged repositories and mismatched immutable GitHub owners fail closed",async()=>{
 for(const options of [{unmanaged:true},{otherOwner:true}]){
  const h=harness(options);
  await assert.rejects(proposeWebsiteUpdate(await approvedInput(),{...auth,fetchFn:h.fetchFn}),/owner|managed resource/);
  assert(h.history.every(x=>x.method==="GET"));
 }
});
test("a changed main commit requires a fresh review; never quietly rebase the approved edit",async()=>{
 const h=harness({mainSha:"d".repeat(40)});
 await assert.rejects(proposeWebsiteUpdate(await approvedInput(),{...auth,fetchFn:h.fetchFn}),/changed since preview/);
 assert(h.history.every(x=>x.method==="GET"));
});
test("an existing branch with unrelated content is never overwritten",async()=>{
 const h=harness();const approved=await approvedInput();
 const first=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 h.state.branchHtml="<html>unrelated modifications</html>";
 const previous=h.state.updates;
 await assert.rejects(proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn}),/unrelated changes/);
 assert.equal(h.state.updates,previous);
 assert.equal(first.reused,false);
});
test("an exact homepage on a branch with unrelated changes or the wrong parent cannot be reused",async()=>{
 for(const change of [{extraFile:true},{updateParent:"f".repeat(40)}]){
   const h=harness(),approved=await approvedInput();
   await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
   h.state.prs=[];
   Object.assign(h.state,change);
   const before=h.history.length;
   await assert.rejects(proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn}),/unrelated changes/);
   assert(h.history.slice(before).every(call=>call.method==="GET"));
   assert.equal(h.state.prsCreated,1);
 }
});
test("interrupted update after branch creation resumes, without duplicating Git references",async()=>{
 const h=harness(),approved=await approvedInput();
 h.state.failUpdateOnce=true;
 await assert.rejects(proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn}),/HTTP 503/);
 assert.equal(h.state.createdRefs,1);assert.equal(h.state.prsCreated,0);
 const resumed=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(resumed.status,"awaiting-customer-merge");
 assert.equal(h.state.createdRefs,1);assert.equal(h.state.updates,1);assert.equal(h.state.prsCreated,1);
});
test("interrupted update after file staging can resume PR creation",async()=>{
 const h=harness(),approved=await approvedInput();
 await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 h.state.prs=[];
 const resumed=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(resumed.status,"awaiting-customer-merge");
 assert.equal(h.state.updates,1);assert.equal(h.state.prsCreated,2);
});
test("closed prior PR prevents accidental replacement without a new approval cycle",async()=>{
 const h=harness(),approved=await approvedInput();
 await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 h.state.prs[0].state="closed";
 await assert.rejects(proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn}),/requires review/);
 assert.equal(h.state.prsCreated,1);
});
test("unchanged approved copy does not create a PR or modify GitHub",async()=>{
 const approved=await approvedInput(),h=harness({currentHtml:renderSite({...input.site,name})});
 const r=await proposeWebsiteUpdate(approved,{...auth,fetchFn:h.fetchFn});
 assert.equal(r.status,"already-current");
 assert.equal(r.changesProposed,false);
 assert(h.history.every(x=>x.method==="GET"));
});
test("unsupported forms, domains and missing GitHub token are rejected before any writes",async()=>{
 const h=harness(),approved=await approvedInput();
 for(const bad of [{...approved,forms:true},{...approved,hostname:"example.com"}])
  await assert.rejects(proposeWebsiteUpdate(bad,{...auth,fetchFn:h.fetchFn}),/static template/);
 await assert.rejects(proposeWebsiteUpdate(approved,{fetchFn:h.fetchFn}),/GitHub user access/);
 assert.equal(h.history.length,0);
});
