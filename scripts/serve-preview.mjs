// Loopback-only zero-dependency HTTP server for generated site previews.
// Only serves the four known static HTML routes; no directory browsing.
import {createServer} from "node:http";
import {readFile,lstat} from "node:fs/promises";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";

const ROUTES=Object.freeze(new Map([
  ["/","index.html"],["/index.html","index.html"],
  ["/about/","about/index.html"],["/about/index.html","about/index.html"],
  ["/services/","services/index.html"],["/services/index.html","services/index.html"],
  ["/contact/","contact/index.html"],["/contact/index.html","contact/index.html"]
]));
export function createPreviewServer({directory}){
  if(typeof directory!=="string"||!directory.trim())throw Error("Preview directory is required");
  const root=resolve(directory);
  return createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if(req.method!=="GET"&&req.method!=="HEAD"){
      res.writeHead(405,{"Allow":"GET, HEAD"});
      res.end("Method not allowed");
      return;
    }
    let route;
    try{route=new URL(req.url,"http://127.0.0.1").pathname}
    catch{res.writeHead(400);res.end("Invalid request");return}
    const relative=ROUTES.get(route);
    if(!relative){res.writeHead(404);res.end("Not found");return}
    const filename=join(root,relative);
    try{
      const file=await lstat(filename);
      if(!file.isFile()||file.isSymbolicLink())throw Error("Unsafe preview file");
      const html=await readFile(filename,"utf8");
      if(Buffer.byteLength(html,"utf8")>200000)throw Error("Oversized preview file");
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end(req.method==="HEAD"?"":html);
    }catch{
      res.writeHead(404);
      res.end("Not found");
    }
  });
}
function cliArgs(args){
  if(args.includes("--help")||args.includes("-h"))return {help:true};
  const out={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!["--dir","--port"].includes(key)||typeof value!=="string"||value.startsWith("--")||Object.hasOwn(out,key))
      throw Error("Usage: node scripts/serve-preview.mjs --dir ./site-preview --port 4173");
    out[key]=value;
  }
  if(!out["--dir"])throw Error("A preview --dir is required");
  const port=out["--port"]===undefined?4173:Number(out["--port"]);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error("Port must be between 1 and 65535");
  return {dir:out["--dir"],port};
}
export function cli(args=process.argv.slice(2)){
  const params=cliArgs(args);
  if(params.help){console.log("Usage: node scripts/serve-preview.mjs --dir ./site-preview --port 4173");return}
  const server=createPreviewServer({directory:params.dir});
  // Never bind 0.0.0.0 or an internet-visible interface.
  server.listen(params.port,"127.0.0.1",()=>console.log(
    "Local preview: http://127.0.0.1:"+params.port+"/ (Ctrl+C to stop)"));
  return server;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{cli()}catch(e){console.error("Preview server failed: "+e.message);process.exitCode=1}
}
