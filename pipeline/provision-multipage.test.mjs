import test from "node:test";
import assert from "node:assert/strict";
import {applyWebsite,previewWebsite} from "./provision-site.mjs";
import {renderSiteBundle,BUNDLE_PATHS,siteBundleApprovalSha256} from "../site/render-site-bundle.mjs";

const customer={name:"Willow Studio",accountId:"0123456789abcdef0123456789abcdef",githubOwner:"tester",
  site:{layout:"multi-page",tagline:"Photography for important moments",
    about:"Family portraits and community event photography.",
    services:["Family portraits","Community events"],theme:"forest",contactEmail:"hello@willow.example"}};
const expectedRepo="esp-willow-studio",project=expectedRepo+"-site",head="a".repeat(40);
customer.approvedBundleSha256=await siteBundleApprovalSha256({...customer.site,name:customer.name});
function harness({repositoryExists=false,failPages=false}={}){
 const state={repo:repositoryExists?{id:321,name:expectedRepo,
   description:"Launch & Own managed site: willow-studio",private:true,default_branch:"main",
   owner:{login:"tester"}}:null,files:{},pagesProject:null,history:[]};
 const response=(json,status=200)=>new Response(JSON.stringify(json),{status,headers:{"content-type":"application/json"}});
 const fetchFn=async(url,opts={})=>{
   const u=new URL(url),method=opts.method||"GET",path=u.pathname;
   const body=opts.body?JSON.parse(opts.body):null;
   state.history.push({host:u.hostname,method,path});
   if(u.hostname==="api.github.com"){
     if(path==="/user"&&method==="GET")return response({login:"tester",id:42});
     if(path==="/repos/tester/"+expectedRepo&&method==="GET")
       return state.repo?response(state.repo):response({message:"not found"},404);
     if(path==="/user/repos"&&method==="POST"){
       assert.equal(body.private,true);
       state.repo={id:321,name:expectedRepo,description:body.description,private:true,default_branch:"main",
         owner:{login:"tester"}};
       return response(state.repo,201);
     }
     if(path==="/repos/tester/"+expectedRepo+"/branches/main"&&method==="GET")
       return response({commit:{sha:head}});
     const prefix="/repos/tester/"+expectedRepo+"/contents/";
     if(path.startsWith(prefix)){
       const file=decodeURIComponent(path.slice(prefix.length));
       if(method==="GET"){
         const html=state.files[file];
         return typeof html==="string"?response({type:"file",sha:"b".repeat(40),encoding:"base64",
           content:Buffer.from(html,"utf8").toString("base64")}):response({message:"not found"},404);
       }
       if(method==="PUT"){
         assert.equal(body.branch,"main");
         assert.equal(typeof state.files[file],"undefined");
         state.files[file]=Buffer.from(body.content,"base64").toString("utf8");
         return response({content:{sha:"c".repeat(40)}},201);
       }
     }
   }
   if(u.hostname==="api.cloudflare.com"){
     const root="/client/v4/accounts/"+customer.accountId+"/pages/projects";
     if(path===root+"/"+project&&method==="GET")
       return state.pagesProject?response({success:true,result:state.pagesProject}):response({success:false},404);
     if(path===root&&method==="POST"){
       if(failPages)return response({success:false},503);
       assert.equal(body.build_config.destination_dir,"public");
       state.pagesProject={name:project,production_branch:"main",
         source:{type:"github",config:{owner:"tester",repo_name:expectedRepo,repo_id:"321"}}};
       return response({success:true,result:state.pagesProject},201);
     }
   }
   throw Error("Unexpected mock "+method+" "+path);
 };
 return {state,fetchFn};
}
const tokens={githubToken:"test-gh-token",cloudflareToken:"test-cf-token"};
test("opt-in multi-page provisioning creates four approved HTML routes and one private Pages project",async()=>{
 const h=harness();
 const result=await applyWebsite(customer,{...tokens,fetchFn:h.fetchFn});
 assert.equal(result.pageCount,4);
 assert.equal(result.status,"awaiting-live-deployment-verification");
 assert.equal(result.headCommitSha,head);
 assert.equal(h.state.repo.private,true);
 assert(h.state.pagesProject);
 assert.deepEqual(Object.keys(h.state.files).sort(),[...BUNDLE_PATHS].sort());
 const bundle=renderSiteBundle({...customer.site,name:customer.name});
 for(const {path,html} of bundle.pages)assert.equal(h.state.files[path],html);
 assert.equal(result.journal.filter(x=>x.resource==="site-page").length,3);
 assert.equal(result.journal.filter(x=>x.resource==="homepage").length,1);
 assert(!h.state.history.some(x=>x.method==="DELETE"));
});
test("identical multi-page retry is read-only, idempotent, and reuses existing resources",async()=>{
 const h=harness();await applyWebsite(customer,{...tokens,fetchFn:h.fetchFn});
 h.state.history.length=0;
 const result=await applyWebsite(customer,{...tokens,fetchFn:h.fetchFn});
 assert.equal(result.journal.filter(x=>x.action==="preserved").length,4);
 assert.equal(result.journal.filter(x=>x.action==="reused").length,2);
 assert(h.state.history.every(x=>x.method==="GET"));
});
test("a content mismatch on any later page prevents writing earlier missing pages",async()=>{
 const h=harness({repositoryExists:true});
 h.state.files["public/contact/index.html"]="<!doctype html><p>Unapproved customer content</p>";
 const before=structuredClone(h.state.files);
 await assert.rejects(applyWebsite(customer,{...tokens,fetchFn:h.fetchFn}),/differs from the approved preview/);
 assert.deepEqual(h.state.files,before);
 assert(h.state.history.every(x=>x.method==="GET"));
});
test("missing pages are created safely on an interrupted approved retry",async()=>{
 const h=harness({repositoryExists:true});
 const bundle=renderSiteBundle({...customer.site,name:customer.name});
 h.state.files["public/index.html"]=bundle.pages[0].html;
 h.state.files["public/about/index.html"]=bundle.pages[1].html;
 const result=await applyWebsite(customer,{...tokens,fetchFn:h.fetchFn});
 assert.equal(result.journal.filter(x=>x.action==="preserved").length,2);
 assert.equal(result.journal.filter(x=>x.action==="created"&&x.resource==="site-page").length,2);
 assert.equal(Object.keys(h.state.files).length,4);
});
test("partial provider failures leave customer files unchanged and safely retry Pages only",async()=>{
 const h=harness({failPages:true});
 await assert.rejects(applyWebsite(customer,{...tokens,fetchFn:h.fetchFn}),/HTTP 503/);
 const content=structuredClone(h.state.files);
 // Simulate a fresh run after the temporary provider outage.
 const recovered=harness({repositoryExists:true});
 recovered.state.files=content;
 const result=await applyWebsite(customer,{...tokens,fetchFn:recovered.fetchFn});
 assert.equal(result.journal.filter(x=>x.action==="preserved").length,4);
 assert.equal(result.journal.filter(x=>x.resource==="cloudflare-pages"&&x.action==="created").length,1);
 assert(recovered.state.history.filter(x=>x.method==="PUT").length===0);
});

test("missing or mismatched multi-page digest prevents every provider request",async()=>{
 const h=harness();
 const without={...customer,approvedBundleSha256:undefined};
 await assert.rejects(applyWebsite(without,{...tokens,fetchFn:h.fetchFn}),/Approval of the complete website bundle/);
 const changed={...customer,site:{...customer.site,about:"Different content after customer approval"}};
 await assert.rejects(applyWebsite(changed,{...tokens,fetchFn:h.fetchFn}),/differs from the exact approved preview/);
 assert.equal(h.state.history.length,0);
});
test("legacy default site remains one page and rejects unsupported layouts before any network request",async()=>{
 const h=harness();
 assert.equal(previewWebsite(customer).pageCount,4);
 assert.equal(previewWebsite({...customer,site:{name:"Willow Studio"}}).pageCount,1);
 await assert.rejects(applyWebsite({...customer,site:{...customer.site,layout:"../secret"}},
   {...tokens,fetchFn:h.fetchFn}),/Unsupported website layout/);
 assert.equal(h.state.history.length,0);
});
