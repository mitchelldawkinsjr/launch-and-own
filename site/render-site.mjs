// Deterministic, responsive, script-free business landing page.
// Used identically for the private approval preview and GitHub deployment.
const THEMES={
 ocean:{bg:"#eef6fd",ink:"#172b48",soft:"#3e566c",accent:"#1c548d",surface:"#fff",border:"#d8e4ef"},
 forest:{bg:"#f0f7ee",ink:"#213b2d",soft:"#4b6357",accent:"#286247",surface:"#fff",border:"#d5e4d8"},
 sunset:{bg:"#fff4eb",ink:"#49312d",soft:"#72534e",accent:"#994936",surface:"#fff",border:"#edddcc"},
 graphite:{bg:"#f1f4f7",ink:"#25303d",soft:"#4b5e6e",accent:"#334f6c",surface:"#fff",border:"#dce4e9"}
};
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function bounded(value,max,label,required=false){
 if(value===undefined||value===null)value="";
 if(typeof value!=="string")throw Error(label+" must be text");
 const normalized=value.trim().replace(/\s+/g," ");
 if(normalized.length>max||(required&&!normalized))throw Error(label+" must have "+(required?"1–":"0–")+max+" characters");
 return normalized;
}
export function normalizeSite(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Site details must be an object");
 const name=bounded(input.name,80,"Business name",true);
 const tagline=bounded(input.tagline,140,"Headline")||"A welcoming place to discover what we do";
 const about=bounded(input.about,650,"About text")||"We're glad you're here. Explore our services and get in touch to learn more.";
 const theme=input.theme??"ocean";
 if(typeof theme!=="string"||!Object.hasOwn(THEMES,theme))throw Error("Unsupported website theme");
 let services=input.services??[];
 if(typeof services==="string")services=services.split(/[\r\n]+/);
 if(!Array.isArray(services)||services.length>6)throw Error("Provide up to six services");
 services=services.map((s,i)=>bounded(s,85,"Service "+(i+1))).filter(Boolean);
 const contactEmail=bounded(input.contactEmail,254,"Contact email");
 if(contactEmail&&!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(contactEmail))
  throw Error("Enter a valid contact email or leave it blank");
 return {name,tagline,about,services,theme,contactEmail};
}
const css=[
 "*{box-sizing:border-box}html{scroll-behavior:smooth}",
 "body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--ink);background:var(--bg);line-height:1.65}",
 "a{color:var(--accent)}a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}",
 "header{padding:18px 0;background:var(--surface);border-bottom:1px solid var(--border)}",
 ".container{width:min(1120px,calc(100% - 40px));margin-inline:auto}",
 ".nav{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}",
 ".brand{font-size:1.2rem;font-weight:800;text-decoration:none;color:var(--ink)}",
 "nav{display:flex;gap:20px;flex-wrap:wrap}nav a{text-decoration:none;font-weight:600}",
 ".hero{position:relative;overflow:hidden;padding:clamp(70px,11vw,145px) 0 110px}",
 ".hero:after{content:'';position:absolute;right:-170px;top:-130px;width:430px;height:430px;border:55px solid var(--border);border-radius:50%;pointer-events:none}",
 ".eyebrow{font-size:.85rem;letter-spacing:.12em;font-weight:800;text-transform:uppercase;color:var(--accent)}",
 "h1{font-size:clamp(2.6rem,6vw,5.3rem);line-height:1.08;max-width:850px;margin:20px 0;letter-spacing:-.06em}",
 ".hero p{font-size:clamp(1.05rem,2vw,1.25rem);max-width:670px;color:var(--soft)}",
 ".btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:14px 22px;border-radius:9px;font-weight:700;margin-top:18px}",
 "section.content{padding:76px 0}h2{font-size:clamp(1.8rem,4vw,2.9rem);letter-spacing:-.04em;line-height:1.2;margin:0 0 22px}",
 ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:18px}",
 ".service{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px}",
 ".service h3{font-size:1.2rem;margin:14px 0 8px}.service p,.about{color:var(--soft)}",
 ".count{font-weight:800;color:var(--accent);letter-spacing:.1em}",
 ".contact{background:var(--surface);border-block:1px solid var(--border)}",
 "footer{padding:26px 0;font-size:.88rem;color:var(--soft)}",
 "@media(max-width:640px){header{padding:14px 0}.hero{padding:74px 0}.hero:after{width:250px;height:250px;right:-160px}section.content{padding:56px 0}nav{gap:14px}}",
 "@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}"
].join("");
const FORM_WORKER=/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/;
const FORM_SITEKEY=/^[A-Za-z0-9_-]{8,64}$/;
const TURNSTILE="https://challenges.cloudflare.com";
// contactForm: the site's own deployed form service. Without one the page is byte-for-byte unchanged.
const formCss=".lo-form{display:grid;gap:12px;max-width:520px;margin-top:18px}.lo-form label{font-weight:600}"+
 ".lo-form input,.lo-form textarea{font:inherit;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink)}"+
 ".lo-form-note{display:none}.lo-form-note:target{display:block;font-weight:600}";
const formHtml=form=>'<p>Send us a message and we will get back to you.</p>'+
 '<form class="lo-form" action="'+form.workerUrl+'/submit" method="post">'+
 '<label for="lo-name">Name</label><input id="lo-name" name="name" autocomplete="name" required maxlength="120">'+
 '<label for="lo-email">Email</label><input id="lo-email" name="email" type="email" autocomplete="email" required maxlength="254">'+
 '<label for="lo-message">Message</label><textarea id="lo-message" name="message" rows="5" required maxlength="4000"></textarea>'+
 '<div class="cf-turnstile" data-sitekey="'+form.sitekey+'"></div><button class="btn" type="submit">Send message</button></form>'+
 '<p id="form-sent" class="lo-form-note" role="status">Thanks, your message was sent.</p>'+
 '<p id="form-error" class="lo-form-note" role="alert">Your message was not sent. Check the form and try again.</p>';
export function renderSite(input,{contactForm}={}){
 const site=normalizeSite(input),theme=THEMES[site.theme];
 const form=contactForm&&FORM_WORKER.test(contactForm.workerUrl||"")&&FORM_SITEKEY.test(contactForm.sitekey||"")?contactForm:null;
 const palette=":root{--bg:"+theme.bg+";--ink:"+theme.ink+";--soft:"+theme.soft+";--accent:"+theme.accent+";--surface:"+theme.surface+";--border:"+theme.border+"}";
 const services=site.services.length?site.services:["Friendly service","Practical solutions","A personal approach"];
 const entries=services.map((s,i)=>'<article class="service"><span class="count">0'+(i+1)+'</span><h3>'+escapeHtml(s)+'</h3><p>Learn more about what we can do for you.</p></article>').join("");
 const contact=site.contactEmail?
  '<p>Have a question? We would love to hear from you.</p><a class="btn" href="mailto:'+escapeHtml(site.contactEmail)+'">Email us</a>':
  '<p>Thanks for visiting. Contact details will appear here once the owner adds them.</p>';
 const name=escapeHtml(site.name),about=escapeHtml(site.about);
 return '<!doctype html><html lang="en"><head><meta charset="utf-8">'+
  '<meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<meta name="description" content="'+escapeHtml(site.about.slice(0,155))+'">'+
  (form
  ?'<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; script-src https://static.cloudflareinsights.com '+TURNSTILE+'; frame-src '+TURNSTILE+'; connect-src &#39;self&#39; https://cloudflareinsights.com '+TURNSTILE+'; base-uri &#39;none&#39;; form-action '+form.workerUrl+'">'
  :'<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; script-src https://static.cloudflareinsights.com; connect-src &#39;self&#39; https://cloudflareinsights.com; base-uri &#39;none&#39;; form-action &#39;none&#39;">')+
  '<title>'+name+' | Welcome</title><style>'+palette+css+(form?formCss:'')+'</style></head><body>'+
  '<header><div class="container nav"><a class="brand" href="#top">'+name+'</a>'+
  '<nav aria-label="Main navigation"><a href="#services">Services</a><a href="#about">About</a><a href="#contact">Contact</a></nav></div></header>'+
  '<main id="top"><section class="hero"><div class="container"><span class="eyebrow">Welcome to '+name+'</span>'+
  '<h1>'+escapeHtml(site.tagline)+'</h1><p>'+about+'</p><a class="btn" href="#services">Explore our services</a></div></section>'+
  '<section class="content" id="services"><div class="container"><p class="eyebrow">What we offer</p><h2>How we can help</h2><div class="grid">'+entries+'</div></div></section>'+
  '<section class="content" id="about"><div class="container"><p class="eyebrow">Our story</p><h2>About '+name+'</h2><p class="about">'+about+'</p></div></section>'+
  '<section class="content contact" id="contact"><div class="container"><p class="eyebrow">Get in touch</p><h2>Let us connect</h2>'+(form?formHtml(form):contact)+'</div></section></main>'+
  '<footer><div class="container">'+name+' · Created with Launch &amp; Own</div></footer>'+
  (form?'<script src="'+TURNSTILE+'/turnstile/v0/api.js" async defer></script>':'')+'</body></html>';
}
