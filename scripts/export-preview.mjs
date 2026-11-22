// Launch & Own local website preview exporter (Node 22+, zero dependencies).
// Generates the SAME HTML used by provision-site.mjs and never calls providers.
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {normalizeSite,renderSite} from "../site/render-site.mjs";
import {renderSiteBundle,siteBundleApprovalSha256} from "../site/render-site-bundle.mjs";

const VALID_PATHS=new Set(["index.html","about/index.html","services/index.html","contact/index.html"]);
const hash=value=>createHash("sha256").update(value,"utf8").digest("hex");

export async function prepareLocalPreview(input){
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Website input must be a JSON object");
  if(input.layout!==undefined&&input.layout!=="multi-page")
    throw Error("Only the default single-page or multi-page layout is supported");
  const site=normalizeSite(input);
  const multi=input.layout==="multi-page";
  const pages=multi?
    renderSiteBundle({...site,layout:"multi-page"}).pages.map(p=>({
      path:p.path.slice("public/".length),html:p.html
    })):
    [{path:"index.html",html:renderSite(site)}];
  if(pages.some(page=>!VALID_PATHS.has(page.path)||typeof page.html!=="string"))
    throw Error("Renderer returned an unsafe output path");
  const approvedBundleSha256=multi?
    await siteBundleApprovalSha256({...site,layout:"multi-page"}):
    null;
  const meta={
    format:"launch-and-own-local-preview-v1",
    mode:multi?"multi-page":"single-page",
    siteName:site.name,
    pageCount:pages.length,
    approvedBundleSha256,
    notice:"This is an offline site preview, not an approved or deployed website.",
    pages:pages.map(p=>({path:p.path,sha256:hash(p.html),bytes:Buffer.byteLength(p.html,"utf8")}))
  };
  return {pages,manifest:meta};
}
export async function writeLocalPreview({site,outputDir}){
  if(typeof outputDir!=="string"||!outputDir.trim())throw Error("A new output directory is required");
  const {pages,manifest}=await prepareLocalPreview(site);
  const root=resolve(outputDir);
  // Never overwrite an existing output directory or any existing website file.
  // Root's parent must already exist; avoid implicit recursive directories.
  try{
    await mkdir(root);
  }catch(error){
    if(error&&error.code==="EEXIST"){
      throw Error(
        "Output directory already exists: "+root+
        ". Choose a new --out path, or remove that folder if it is only a local preview."
      );
    }
    throw error;
  }
  for(const page of pages){
    const destination=join(root,page.path);
    if(page.path.includes("/"))await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,page.html,{encoding:"utf8",flag:"wx"});
  }
  await writeFile(join(root,"preview-manifest.json"),JSON.stringify(manifest,null,2)+"\n",
    {encoding:"utf8",flag:"wx"});
  return {directory:root,...manifest};
}
function parseArgs(args){
  if(args.includes("--help")||args.includes("-h"))return {help:true};
  const flags={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!["--input","--out"].includes(key)||typeof value!=="string"||value.startsWith("--")||
      Object.hasOwn(flags,key))throw Error("Usage: node scripts/export-preview.mjs --input examples/willow-studio.json --out ./site-preview");
    flags[key]=value;
  }
  if(!flags["--input"]||!flags["--out"])throw Error("Both --input and --out are required");
  return {input:flags["--input"],out:flags["--out"]};
}
export async function cli(args=process.argv.slice(2)){
  const flags=parseArgs(args);
  if(flags.help){
    console.log("Usage: node scripts/export-preview.mjs --input examples/willow-studio.json --out ./site-preview");
    return;
  }
  const raw=await readFile(resolve(flags.input),"utf8");
  if(Buffer.byteLength(raw,"utf8")>16000)throw Error("Website brief JSON is too large");
  const site=JSON.parse(raw);
  const exported=await writeLocalPreview({site,outputDir:flags.out});
  console.log("Local-only preview created: "+exported.directory);
  console.log("Pages: "+exported.pageCount+" ("+exported.mode+")");
  if(exported.approvedBundleSha256)console.log("Full bundle SHA-256: "+exported.approvedBundleSha256);
  console.log("Serve locally: node scripts/serve-preview.mjs --dir "+JSON.stringify(exported.directory));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  cli().catch(e=>{
    console.error("Preview export failed: "+e.message);
    process.exitCode=1;
  });
}
