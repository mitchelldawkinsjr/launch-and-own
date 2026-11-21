// Customer-owned, dependency-free four-page site; never embeds remote assets or scripts.
import {normalizeSite} from "./render-site.mjs";

export const BUNDLE_PATHS=Object.freeze(["public/index.html","public/about/index.html","public/services/index.html","public/contact/index.html"]);
const esc=x=>String(x).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const THEMES={
  ocean:{bg:"#eef6fd",ink:"#172b48",accent:"#1c548d",soft:"#3e566c",tint:"#d8e4ef"},
  forest:{bg:"#f0f7ee",ink:"#213b2d",accent:"#286247",soft:"#4b6357",tint:"#d5e4d8"},
  sunset:{bg:"#fff4eb",ink:"#49312d",accent:"#994936",soft:"#72534e",tint:"#edddcc"},
  graphite:{bg:"#f1f4f7",ink:"#25303d",accent:"#334f6c",soft:"#4b5e6e",tint:"#dce4e9"}
};
const LINKS=[{key:"home",title:"Home",href:"/"},{key:"about",title:"About",href:"/about/"},
  {key:"services",title:"Services",href:"/services/"},{key:"contact",title:"Contact",href:"/contact/"}];
const CSS=[
  "*{box-sizing:border-box}html{scroll-behavior:smooth}",
  "body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.65}",
  "a{color:var(--accent)}a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}",
  ".skip{position:absolute;left:12px;top:-100px;padding:12px;background:#fff}.skip:focus{top:12px}",
  ".wrap{width:min(1120px,calc(100% - 44px));margin-inline:auto}",
  "header{background:#fff;border-bottom:1px solid var(--tint)}",
  "nav{padding:18px 0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:20px}",
  ".brand{font-size:1.25rem;font-weight:850;letter-spacing:-.035em;text-decoration:none;color:var(--ink)}",
  ".links{display:flex;align-items:center;gap:clamp(12px,2.5vw,28px);flex-wrap:wrap}",
  ".links a{text-decoration:none;font-size:.94rem;font-weight:750}",
  ".links [aria-current=page]{border-bottom:3px solid var(--accent)}",
  ".hero{position:relative;overflow:hidden;padding:clamp(78px,11vw,145px) 0}",
  ".hero:after{content:'';position:absolute;right:-150px;top:-160px;width:400px;height:400px;border:70px solid var(--tint);border-radius:50%;pointer-events:none}",
  ".eyebrow{font-weight:850;color:var(--accent);font-size:.83rem;letter-spacing:.13em;text-transform:uppercase}",
  "h1{font-size:clamp(2.9rem,6.6vw,5.7rem);line-height:1.08;letter-spacing:-.065em;max-width:900px;margin:20px 0}",
  "h2{font-size:clamp(1.85rem,4vw,3.1rem);line-height:1.2;letter-spacing:-.04em;margin:8px 0 22px}",
  "h3{font-size:1.25rem;line-height:1.4}",
  ".section{padding:clamp(58px,9vw,106px) 0}.surface{background:#fff;border-block:1px solid var(--tint)}",
  ".lead{font-size:clamp(1.08rem,2vw,1.28rem);max-width:750px;color:var(--soft)}",
  ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:18px;margin:32px 0}",
  ".tile{border:1px solid var(--tint);background:#fff;border-radius:18px;padding:28px;min-height:180px}",
  ".tile p,.copy{color:var(--soft)}.count{font-weight:850;font-size:.8rem;color:var(--accent)}",
  ".columns{display:grid;grid-template-columns:1fr 1fr;align-items:start;gap:clamp(30px,7vw,100px)}",
  ".panel{padding:34px;background:var(--tint);border-radius:20px}",
  ".btn{display:inline-block;padding:14px 22px;margin-top:20px;background:var(--accent);color:white;text-decoration:none;border-radius:9px;font-weight:750}",
  "footer{padding:30px 0;border-top:1px solid var(--tint);color:var(--soft)}footer a{color:var(--accent)}",
  "@media(max-width:700px){.columns{grid-template-columns:1fr}.hero:after{width:230px;height:230px;border-width:35px;right:-140px}}",
  "@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}"
].join("");
function page(site,key,title,body){
  const theme=THEMES[site.theme],name=esc(site.name);
  const cssColors=":root{--bg:"+theme.bg+";--ink:"+theme.ink+";--soft:"+theme.soft+
    ";--accent:"+theme.accent+";--tint:"+theme.tint+"}";
  const nav=LINKS.map(l=>'<a href="'+l.href+'"'+(key===l.key?' aria-current="page"':'')+'>'+l.title+"</a>").join("");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="description" content="'+esc(site.about.slice(0,155))+'">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">'+
    "<title>"+esc(title)+" | "+name+"</title><style>"+cssColors+CSS+"</style></head><body>"+
    '<a class="skip" href="#main">Skip to content</a>'+
    '<header><nav class="wrap" aria-label="Main navigation"><a class="brand" href="/">'+name+
    '</a><div class="links">'+nav+"</div></nav></header>"+
    '<main id="main">'+body+"</main>"+
    '<footer><div class="wrap"><strong>'+name+'</strong> · <a href="/about/">About</a> · '+
    '<a href="/services/">Services</a> · <a href="/contact/">Contact</a></div></footer></body></html>';
}
function hero(name,headline){
  return '<section class="hero"><div class="wrap"><span class="eyebrow">Welcome to '+name+
    "</span><h1>"+headline+"</h1></div></section>";
}
function contactLink(site){
  return site.contactEmail?
    '<a class="btn" href="mailto:'+esc(site.contactEmail)+'">Email '+esc(site.name)+"</a>":
    '<p class="copy">Contact details can be added by the website owner.</p>';
}
function cards(labels){
  return '<div class="grid">'+labels.map((label,i)=>
    '<article class="tile"><span class="count">SERVICE 0'+(i+1)+'</span><h3>'+
    esc(label)+'</h3><p>Get in touch to learn more about this service.</p></article>').join("")+"</div>";
}
export function renderSiteBundle(input){
  if(input?.layout!==undefined&&input.layout!=="multi-page")throw Error("Unsupported website bundle layout");
  const site=normalizeSite(input),name=esc(site.name),tag=esc(site.tagline),about=esc(site.about);
  const services=site.services.length?site.services:["Ask about our services"];
  const home=page(site,"home","Home",hero(name,tag)+
    '<section class="section surface"><div class="wrap"><span class="eyebrow">What we offer</span>'+
    "<h2>How we can help</h2><p class=\"lead\">"+about+"</p>"+cards(services.slice(0,3))+
    '<a class="btn" href="/services/">View our services</a></div></section>'+
    '<section class="section"><div class="wrap columns"><div><span class="eyebrow">About us</span>'+
    "<h2>Get to know "+name+'</h2><p class="copy">'+about+
    '</p><a class="btn" href="/about/">Our story</a></div><div class="panel"><h3>Questions?</h3>'+
    '<p>Let us know how we can help.</p>'+contactLink(site)+"</div></div></section>");
  const aboutPage=page(site,"about","About",hero(name,"Get to know "+name)+
    '<section class="section surface"><div class="wrap columns"><div><span class="eyebrow">Our story</span>'+
    "<h2>About "+name+'</h2></div><div><p class="lead">'+about+
    '</p><a class="btn" href="/contact/">Contact us</a></div></div></section>');
  const servicePage=page(site,"services","Services",hero(name,"Explore our services")+
    '<section class="section surface"><div class="wrap"><span class="eyebrow">What we do</span>'+
    '<h2>Ways we can help</h2><p class="lead">'+about+"</p>"+cards(services)+
    '<a class="btn" href="/contact/">Ask a question</a></div></section>');
  const contactPage=page(site,"contact","Contact",hero(name,"Let’s connect")+
    '<section class="section surface"><div class="wrap columns"><div><span class="eyebrow">Get in touch</span>'+
    "<h2>We’d love to hear from you</h2><p class=\"lead\">"+about+
    '</p></div><div class="panel"><h3>Contact '+name+
    '</h3><p>Reach out with any questions about what we offer.</p>'+contactLink(site)+"</div></div></section>");
  return {mode:"multi-page",pageCount:4,pages:Object.freeze([
    Object.freeze({path:BUNDLE_PATHS[0],html:home}),
    Object.freeze({path:BUNDLE_PATHS[1],html:aboutPage}),
    Object.freeze({path:BUNDLE_PATHS[2],html:servicePage}),
    Object.freeze({path:BUNDLE_PATHS[3],html:contactPage})
  ])};
}

// A review records the digest of ALL approved page paths and HTML, not just
// the homepage. Any changed page, ordering or content invalidates the approval.
export async function siteBundleApprovalSha256(input){
  const bundle=renderSiteBundle(input);
  const canonical=JSON.stringify(bundle.pages.map(p=>[p.path,p.html]));
  const encoded=new TextEncoder().encode(canonical);
  const hashed=await crypto.subtle.digest("SHA-256",encoded);
  return Array.from(new Uint8Array(hashed),byte=>byte.toString(16).padStart(2,"0")).join("");
}
