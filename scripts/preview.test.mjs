import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {renderSite} from "../site/render-site.mjs";
import {renderSiteBundle,siteBundleApprovalSha256} from "../site/render-site-bundle.mjs";
import {prepareLocalPreview,writeLocalPreview,cli} from "./export-preview.mjs";
import {createPreviewServer} from "./serve-preview.mjs";

const site={
  name:"Willow Studio",layout:"multi-page",tagline:"Moments worth keeping",
  about:"A fictional business offering family photography and neighborhood event photography.",
  services:["Family portraits","Community events"],theme:"forest",
  contactEmail:"hello@willow.example"
};
const makeRoot=()=>mkdtemp(join(tmpdir(),"launch-own-preview-test-"));
test("local preview returns exact deployable four-page renderer HTML and approval digest",async()=>{
 const result=await prepareLocalPreview(site);
 assert.equal(result.manifest.mode,"multi-page");
 assert.equal(result.manifest.pageCount,4);
 assert.equal(result.manifest.approvedBundleSha256,await siteBundleApprovalSha256(site));
 const expected=renderSiteBundle(site);
 assert.deepEqual(result.pages.map(p=>p.path),expected.pages.map(p=>p.path.slice(7)));
 for(let i=0;i<4;i++){
  assert.equal(result.pages[i].html,expected.pages[i].html);
  assert.match(result.manifest.pages[i].sha256,/^[a-f0-9]{64}$/);
  assert(result.manifest.pages[i].bytes>100);
 }
 assert(!JSON.stringify(result.manifest).includes("TOKEN_ENCRYPTION_KEY"));
});
test("single-page local preview stays byte-for-byte identical to existing renderer",async()=>{
 const input={name:"Willow Studio",tagline:"Hello",theme:"ocean"};
 const result=await prepareLocalPreview(input);
 assert.deepEqual(result.pages,[{path:"index.html",html:renderSite(input)}]);
 assert.equal(result.manifest.mode,"single-page");
 assert.equal(result.manifest.approvedBundleSha256,null);
 assert.equal(result.manifest.pageCount,1);
});
test("export writes new directory with exact pages, manifest and no remote provider requests",async()=>{
 const root=await makeRoot();
 try{
  const output=join(root,"site-preview");
  const result=await writeLocalPreview({site,outputDir:output});
  assert.equal(result.directory,output);
  assert.equal((await readFile(join(output,"about/index.html"),"utf8")),
    renderSiteBundle(site).pages[1].html);
  const manifest=JSON.parse(await readFile(join(output,"preview-manifest.json"),"utf8"));
  assert.equal(manifest.approvedBundleSha256,await siteBundleApprovalSha256(site));
  assert.equal(manifest.pageCount,4);
  await assert.rejects(writeLocalPreview({site,outputDir:output}),
    /Output directory already exists/);
  assert.equal((await readFile(join(output,"index.html"),"utf8")),
    renderSiteBundle(site).pages[0].html);
 }finally{await rm(root,{recursive:true,force:true})}
});
test("invalid data refuses export before creating output directory",async()=>{
 const root=await makeRoot();
 try{
  for(const [i,input] of [{...site,layout:"../../secrets"},{...site,theme:"injected"},
    {...site,contactEmail:"javascript:alert(1)"},{...site,name:""}].entries()){
    const target=join(root,"invalid-"+i);
    await assert.rejects(writeLocalPreview({site:input,outputDir:target}));
    await assert.rejects(readFile(join(target,"index.html"),"utf8"));
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
test("local HTTP preview serves only known pages over loopback with no-store and CSP",async()=>{
 const root=await makeRoot();
 const output=join(root,"demo");
 const server=createPreviewServer({directory:output});
 try{
  await writeLocalPreview({site,outputDir:output});
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  const address=server.address();
  assert.equal(address.address,"127.0.0.1");
  const base="http://127.0.0.1:"+address.port;
  for(const route of ["/","/about/","/services/","/contact/"]){
    const r=await fetch(base+route);
    assert.equal(r.status,200);
    assert.match(r.headers.get("content-type"),/text\/html/);
    assert.equal(r.headers.get("cache-control"),"no-store");
    assert.match(r.headers.get("content-security-policy"),/default-src 'none'/);
    assert.match(await r.text(),/Willow Studio/);
  }
  assert.equal((await fetch(base+"/preview-manifest.json")).status,404);
  assert.equal((await fetch(base+"/.env")).status,404);
  assert.equal((await fetch(base+"/hidden.txt")).status,404);
  assert.equal((await fetch(base+"/",{method:"POST"})).status,405);
  const head=await fetch(base+"/about/",{method:"HEAD"});
  assert.equal(head.status,200);
  assert.equal(await head.text(),"");
 }finally{
  await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});
test("a one-page preview does not invent extra site pages",async()=>{
 const root=await makeRoot();const output=join(root,"single");
 const server=createPreviewServer({directory:output});
 try{
  await writeLocalPreview({site:{name:"Single Site"},outputDir:output});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+server.address().port;
  assert.equal((await fetch(url+"/")).status,200);
  assert.equal((await fetch(url+"/about/")).status,404);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});
test("local CLI parses an example JSON file without a cloud credential or network",async()=>{
 const root=await makeRoot();
 try{
  const sample=join(root,"brief.json"),output=join(root,"preview");
  await writeFile(sample,JSON.stringify(site));
  await cli(["--input",sample,"--out",output]);
  const index=await readFile(join(output,"index.html"),"utf8");
  assert.match(index,/Moments worth keeping/);
  await assert.rejects(cli(["--input",sample,"--out",output]),
    /Output directory already exists/);
  await assert.rejects(cli(["--input",sample]),/--out are required/);
 }finally{await rm(root,{recursive:true,force:true})}
});
