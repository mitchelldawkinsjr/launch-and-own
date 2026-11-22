// Reproducible, no-account independent-beta dry run. No GitHub/Cloudflare requests.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {writeLocalPreview} from "./export-preview.mjs";
import {createPreviewServer} from "./serve-preview.mjs";
import {previewWebsiteUpdate} from "../pipeline/propose-site-update.mjs";

const hash=html=>createHash("sha256").update(html,"utf8").digest("hex");
const baseline={
  name:"Willow Studio",tagline:"Your moments, beautifully remembered",
  about:"Fictional portrait and community event photography.",
  services:["Family portraits","Community events"],theme:"forest",
  contactEmail:"hello@willow.example"
};
const revised={...baseline,tagline:"Now offering thoughtful family portraits"};
const placeholderAccount="0123456789abcdef0123456789abcdef";

async function rehearseRevision(root,site,label){
  const destination=join(root,label);
  const exported=await writeLocalPreview({site,outputDir:destination});
  assert.equal(exported.pageCount,1);
  assert.equal(exported.mode,"single-page");
  const manifestSha=exported.pages[0].sha256;
  const proposal=await previewWebsiteUpdate({
    name:site.name,githubOwner:"offline-demo",accountId:placeholderAccount,site
  });
  assert.equal(proposal.status,"preview-only");
  assert.equal(proposal.htmlSha256,manifestSha);
  const server=createPreviewServer({directory:destination});
  try{
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(0,"127.0.0.1",resolve);
    });
    assert.equal(server.address().address,"127.0.0.1");
    const url="http://127.0.0.1:"+server.address().port;
    const response=await fetch(url+"/",{redirect:"error"});
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.match(response.headers.get("content-security-policy"),/default-src 'none'/);
    const served=await response.text();
    assert.equal(hash(served),manifestSha);
    assert.equal(served,proposal.html);
    assert.equal((await fetch(url+"/preview-manifest.json")).status,404);
    assert.equal((await fetch(url+"/.env")).status,404);
    assert.equal((await fetch(url+"/about/")).status,404);
    return {label,sha256:manifestSha,pageCount:1,localhostVerified:true,
      matchesUpdatePreview:true};
  }finally{
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
}
export async function runBetaRehearsal(){
  const root=await mkdtemp(join(tmpdir(),"launch-and-own-beta-qa-"));
  try{
    const initial=await rehearseRevision(root,baseline,"initial");
    const update=await rehearseRevision(root,revised,"proposed-update");
    assert.notEqual(initial.sha256,update.sha256,"The test update must visibly change the page");
    return {
      mode:"offline-localhost-only",providerRequests:0,published:false,
      customerApprovalCollected:false,firstPreview:initial,proposedEdit:update,
      changedRevision:true,
      nextGate:"Hosted OAuth, customer approval, GitHub PR merge and exact production verification require an independent customer"
    };
  }finally{
    await rm(root,{recursive:true,force:true});
  }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  runBetaRehearsal().then(evidence=>console.log(JSON.stringify(evidence,null,2)))
    .catch(error=>{console.error("Offline beta QA failed:",error.message);process.exitCode=1});
}
