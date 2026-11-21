import test from "node:test";
import assert from "node:assert/strict";
import {applyWebsite,previewWebsite} from "./provision-site.mjs";
const input={name:"Test Client",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"tester"};
const repoName="esp-test-client",pagesName=repoName+"-site";
const EXPECTED_SHA="a".repeat(40);
function harness({repoExisting=false,projectExisting=false,otherOwner=false,collision=false,legacyMarker=false,failPages=false}={}) {
 const history=[],state={file:repoExisting,repo:repoExisting?{id:321,name:repoName,description:collision?"Unrelated repository":legacyMarker?"Elite Site Pipeline managed site: test-client":"Launch & Own managed site: test-client",private:true,default_branch:"main",owner:{login:"tester"}}:null,
 project:projectExisting?{name:pagesName,production_branch:"main",source:{type:"github",config:{owner:"tester",repo_name:repoName,repo_id:"321"}}}:null};
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
 const fetchFn=async(url,opts={})=>{
   const u=new URL(url),method=opts.method||"GET",path=u.pathname;
   history.push({method,path});
   let body=opts.body?JSON.parse(opts.body):null;
   if(u.hostname==="api.github.com"){
     if(path==="/user"&&method==="GET")return json({login:otherOwner?"someone-else":"tester"});
     if(path==="/repos/tester/"+repoName&&method==="GET")return state.repo?json(state.repo):json({message:"Not found"},404);
     if(path==="/user/repos"&&method==="POST"){state.repo={id:321,name:repoName,owner:{login:"tester"},description:body.description,private:body.private,default_branch:"main"};return json(state.repo,201);}
     if(path==="/repos/tester/"+repoName+"/branches/main"&&method==="GET")return json({commit:{sha:EXPECTED_SHA}});
     if(path==="/repos/tester/"+repoName+"/contents/public/index.html"&&method==="GET")return state.file?json({type:"file",sha:"abc"}):json({},404);
     if(path==="/repos/tester/"+repoName+"/contents/public/index.html"&&method==="PUT"){
       assert.equal(body.branch,"main");assert.match(Buffer.from(body.content,"base64").toString("utf8"),/Test Client/);
       state.file=true;return json({content:{sha:"new"}},201);
     }
   }
   if(u.hostname==="api.cloudflare.com"){
     if(path==="/client/v4/accounts/"+input.accountId+"/pages/projects/"+pagesName&&method==="GET")return state.project?json({success:true,result:state.project}):json({success:false},404);
     if(path==="/client/v4/accounts/"+input.accountId+"/pages/projects"&&method==="POST"){
       if(failPages)return json({success:false},500);
       assert.equal(body.source.type,"github");assert.equal(body.source.config.repo_name,repoName);
       assert.equal(body.build_config.destination_dir,"public");
       state.project={name:pagesName,production_branch:"main",source:{type:"github",config:{owner:"tester",repo_name:repoName,repo_id:"321"}}};
       return json({success:true,result:state.project},201);
     }
   }
   throw Error("Unexpected mock request: "+method+" "+path);
 };
 return {fetchFn,history,state};
}
const tokens={githubToken:"dummy-gh-token",cloudflareToken:"dummy-cf-token"};
test("preview makes no requests and flags forms as gated",()=>{
 assert.equal(previewWebsite(input).executable,true);
 assert.equal(previewWebsite({...input,forms:true,ownerEmail:"owner@example.com"}).executable,false);
});
test("fresh customer creates only private repo, homepage and git-linked Pages project",async()=>{
 const h=harness();
 const result=await applyWebsite(input,{...tokens,fetchFn:h.fetchFn});
 assert.equal(result.status,"awaiting-live-deployment-verification");
 assert.deepEqual(result.journal.map(e=>e.action),["created","created","created"]);
 assert.equal(result.website,"https://"+pagesName+".pages.dev");
 assert.equal(result.headCommitSha,EXPECTED_SHA);
 assert.equal(h.state.repo.private,true);
 assert(h.state.file&&h.state.project);
});
test("retry reuses managed resources and never overwrites existing content",async()=>{
 const h=harness();await applyWebsite(input,{...tokens,fetchFn:h.fetchFn});
 h.history.length=0;
 const r=await applyWebsite(input,{...tokens,fetchFn:h.fetchFn});
 assert.deepEqual(r.journal.map(e=>e.action),["reused","preserved","reused"]);
 assert(h.history.every(e=>e.method==="GET"));
});
test("legacy beta customer owned repository remains safely resumable after brand change",async()=>{
 const h=harness({repoExisting:true,legacyMarker:true,projectExisting:true});
 const result=await applyWebsite(input,{...tokens,fetchFn:h.fetchFn});
 assert.deepEqual(result.journal.map(e=>e.action),["reused","preserved","reused"]);
 assert(h.history.every(entry=>entry.method==="GET"));
});
test("partially completed repo resumes without duplicating resources",async()=>{
 const h=harness({repoExisting:true});
 h.state.file=false;
 const result=await applyWebsite(input,{...tokens,fetchFn:h.fetchFn});
 assert.deepEqual(result.journal.map(e=>e.action),["reused","created","created"]);
});
test("refuses to adopt unrelated repo",async()=>{
 const h=harness({repoExisting:true,collision:true});
 await assert.rejects(applyWebsite(input,{...tokens,fetchFn:h.fetchFn}),/not an exact matching/);
 assert(h.history.every(e=>e.method==="GET"));
});
test("refuses Cloudflare Pages project attached to another repository",async()=>{
 const h=harness({repoExisting:true,projectExisting:true});
 h.state.project.source.config.repo_id="999";
 await assert.rejects(applyWebsite(input,{...tokens,fetchFn:h.fetchFn}),/not connected/);
 assert(h.history.every(e=>e.method==="GET"));
});
test("rejects unapproved GitHub user before modifying anything",async()=>{
 const h=harness({otherOwner:true});
 await assert.rejects(applyWebsite(input,{...tokens,fetchFn:h.fetchFn}),/authenticated personal GitHub owner/);
 assert.deepEqual(h.history.map(x=>x.method),["GET"]);
});
test("form option refuses to mutate provider resources",async()=>{
 const h=harness();
 await assert.rejects(applyWebsite({...input,forms:true,ownerEmail:"owner@example.com"},{...tokens,fetchFn:h.fetchFn}),/not yet automated/);
 assert.equal(h.history.length,0);
});
test("cloudflare error leaves created repo intact for safe retry, does not delete",async()=>{
 const h=harness({failPages:true});
 await assert.rejects(applyWebsite(input,{...tokens,fetchFn:h.fetchFn}),/HTTP 500/);
 assert(h.state.repo&&h.state.file);
 assert(!h.history.some(e=>e.method==="DELETE"));
});
test("apply requires explicitly supplied provider tokens",async()=>{
 await assert.rejects(applyWebsite(input,{fetchFn:()=>{throw Error("network should not be called")}}),/GITHUB_TOKEN/);
});

test("custom host option refuses to touch resources until domain setup is implemented",async()=>{
 const h=harness();
 assert.equal(previewWebsite({...input,hostname:"example.com"}).executable,false);
 await assert.rejects(applyWebsite({...input,hostname:"example.com"},{...tokens,fetchFn:h.fetchFn}),/Custom domain/);
 assert.equal(h.history.length,0);
});
