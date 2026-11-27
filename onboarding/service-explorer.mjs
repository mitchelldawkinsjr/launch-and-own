/** Shared presentation-only catalog. No provider access or mutation. */
const SERVICES = [
  {
    "id": "github",
    "name": "GitHub",
    "role": "Website files",
    "group": "foundation",
    "icon": "files",
    "description": "A private digital filing cabinet for your website's source files and their change history.",
    "example": "Keep your website files if you decide to move hosting providers.",
    "pre": "Core launch account",
    "post": "Source ownership is established during launch. Current repository access is not verified by this card."
  },
  {
    "id": "pages",
    "name": "Cloudflare Pages",
    "role": "Website hosting",
    "group": "foundation",
    "icon": "globe",
    "description": "Publishes the website files you approved, delivers them around the world, and provides a secure HTTPS address.",
    "example": "Visitors open your website on their phones or computers.",
    "pre": "Core launch account",
    "post": "Hosting status is based on recorded launch evidence.",
    "cap": "static_hosting"
  },
  {
    "id": "turnstile",
    "name": "Turnstile",
    "role": "Spam protection",
    "group": "forms",
    "icon": "shield",
    "description": "Helps distinguish people from automated bots. The server must also validate the protection token.",
    "example": "Reduce automated quote requests from bots.",
    "pre": "Optional · Part of contact form setup",
    "post": "Requires a separate form review; this card does not verify an individual widget."
  },
  {
    "id": "workers",
    "name": "Workers",
    "role": "Automation & logic",
    "group": "forms",
    "icon": "bolt",
    "description": "Runs small programs behind the scenes, such as validating and processing a form submission.",
    "example": "Check a quote request before saving it.",
    "pre": "Optional · Part of contact form setup",
    "post": "Requires separate cost, privacy and form setup review; individual Worker status is not verified here."
  },
  {
    "id": "d1",
    "name": "D1",
    "role": "Database storage",
    "group": "forms",
    "icon": "database",
    "description": "A structured database for information your website collects. Customer form data must live in a separate customer-owned database, not our onboarding database.",
    "example": "Save a customer's name, email and message after an approved form is configured.",
    "pre": "Optional · Part of contact form setup",
    "post": "Requires separate cost, privacy and form setup review; individual database status is not verified here."
  },
  {
    "id": "access",
    "name": "Cloudflare Access",
    "role": "Private areas",
    "group": "forms",
    "icon": "lock",
    "description": "Limits access to private resources to authorized people, such as staff or approved reviewers.",
    "example": "Protect a future inquiry dashboard or restricted website preview.",
    "pre": "Optional · Security review",
    "post": "Requires access policy review and verification; individual Access configuration is not verified here."
  },
  {
    "id": "analytics",
    "name": "Web Analytics",
    "role": "Visitor insights",
    "group": "growth",
    "icon": "chart",
    "description": "Helps you understand website visits and which pages people use.",
    "example": "See whether customers are visiting your services page.",
    "pre": "On by default · You can turn it off before launch",
    "post": "Counts visits and page speed in your own Cloudflare account. No cookies.",
    "cap": "web_analytics"
  },
  {
    "id": "dns",
    "name": "Cloudflare DNS",
    "role": "Custom domain",
    "group": "growth",
    "icon": "network",
    "description": "Connects a website address you own to your hosted site.",
    "example": "Use www.yourbusiness.com instead of your pages.dev address.",
    "pre": "Optional · Domain approval",
    "post": "Review the domain you own before making DNS changes.",
    "cap": "custom_domains"
  },
  {
    "id": "email",
    "name": "Email Routing",
    "role": "Email forwarding",
    "group": "growth",
    "icon": "mail",
    "description": "Forwards messages addressed to your business domain to an existing inbox. It is not a full mailbox or outbound email service.",
    "example": "Forward hello@yourbusiness.com to your existing inbox.",
    "pre": "Optional · Custom domain required",
    "post": "Needs a domain you control and an approved destination inbox.",
    "cap": "email_routing"
  },
  {
    "id": "r2",
    "name": "R2",
    "role": "File storage",
    "group": "growth",
    "icon": "folder",
    "description": "Object storage for files such as images and documents. Customer file storage is different from the product's private ZIP preview storage.",
    "example": "A future website could host downloadable brochures or receive approved file uploads.",
    "pre": "Future customer-facing extension",
    "post": "Future extension; no customer R2 setup action or verified status is offered here."
  }
];
const ICONS = {"files":"<rect x=\"5\" y=\"3\" width=\"14\" height=\"18\" rx=\"2\"/><path d=\"M9 8h6M9 12h6M9 16h4\"/>","globe":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><ellipse cx=\"12\" cy=\"12\" rx=\"4\" ry=\"9\"/><path d=\"M3 12h18\"/>","shield":"<path d=\"M12 3 20 6v6c0 5-3 7-8 9-5-2-8-4-8-9V6zM8 12l3 3 5-6\"/>","bolt":"<path d=\"m13 2-9 12h7l-1 8 10-12h-7z\"/>","database":"<ellipse cx=\"12\" cy=\"5\" rx=\"8\" ry=\"3\"/><path d=\"M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0\"/>","lock":"<rect x=\"5\" y=\"10\" width=\"14\" height=\"11\" rx=\"2\"/><path d=\"M8 10V7a4 4 0 0 1 8 0v3M12 14v3\"/>","chart":"<path d=\"M4 4v16h16M8 16v-5m5 5V7m5 9v-3\"/>","network":"<rect x=\"9\" y=\"3\" width=\"6\" height=\"5\" rx=\"1\"/><rect x=\"3\" y=\"16\" width=\"6\" height=\"5\" rx=\"1\"/><rect x=\"15\" y=\"16\" width=\"6\" height=\"5\" rx=\"1\"/><path d=\"M12 8v4H6v4m6-4h6v4\"/>","mail":"<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"m3 7 9 7 9-7\"/>","folder":"<path d=\"M3 5h7l2 3h9v12H3z\"/>"};
const STATES = {"included_verified":"Included in recorded launch","active_verified":"Verified active","available_opt_in":"Available for review","manual_setup":"Manual setup","blocked_permission_or_plan":"Not ready yet","not_available":"Not available"};
export const serviceExplorerCss = "\n.lo-explorer{--sx-ink:var(--ink,#14253c);--sx-muted:var(--muted,#52637a);--sx-line:var(--line,#dbe5ef);--sx-blue:var(--blue,#2457b8);--sx-orange:var(--orange,#a74410);margin:26px 0 0;color:var(--sx-ink);font:inherit}\n.lo-explorer *{box-sizing:border-box}.lo-explorer h2,.lo-explorer h3,.lo-explorer p{margin:0}.lo-explorer h2{font-size:clamp(1.6rem,3.5vw,2.4rem);line-height:1.15;letter-spacing:-.045em}.lo-explorer h3{font-size:1rem;letter-spacing:-.015em}.lo-explorer p{overflow-wrap:anywhere}.lo-explorer .sx-head{display:grid;gap:8px;margin-bottom:18px}.lo-explorer .sx-head p,.lo-explorer .sx-note{font-size:.88rem;color:var(--sx-muted)}.card .lo-explorer h2{font-size:1.2rem;letter-spacing:-.015em}.lo-explorer .sx-group{border:1px solid var(--sx-line);background:#fff;border-radius:var(--r-lg,16px);padding:16px;margin:12px 0}.lo-explorer .sx-group-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;margin-bottom:12px}.lo-explorer .sx-group-title span{font-size:.8rem;color:var(--sx-muted)}.lo-explorer .sx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,195px),1fr));align-items:start;gap:10px}.lo-explorer details.sx-card{margin:0;padding:0;border:1px solid var(--sx-line);border-radius:var(--r,12px);background:#f8fafc;overflow:hidden}.lo-explorer details.sx-card[open]{border-color:#7899ce;background:#fff}.lo-explorer .sx-card summary{display:flex;align-items:center;gap:9px;cursor:pointer;min-height:72px;padding:12px;list-style:none;color:var(--sx-ink)}.lo-explorer .sx-card summary::-webkit-details-marker{display:none}.lo-explorer .sx-card summary::after{content:\"+\";font-weight:800;color:var(--sx-blue);margin-left:auto}.lo-explorer .sx-card[open] summary::after{content:\"−\"}.lo-explorer .sx-card summary:focus-visible,.lo-explorer summary:focus-visible{outline:3px solid var(--sx-blue);outline-offset:-3px}.lo-explorer .sx-icon{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:#fff0e4;color:var(--sx-orange)}.lo-explorer .sx-icon svg{width:21px;height:21px}.lo-explorer .sx-github .sx-icon{background:#e9eef4;color:#29394b}.lo-explorer .sx-label{display:grid;gap:2px;min-width:0;line-height:1.25}.lo-explorer .sx-label strong{font-size:.94rem}.lo-explorer .sx-label small{font-size:.76rem;color:var(--sx-muted)}.lo-explorer .sx-detail{padding:0 12px 13px;display:grid;gap:9px}.lo-explorer .sx-detail p{font-size:.85rem;line-height:1.5;color:var(--sx-muted)}.lo-explorer .sx-example{background:#eef4fa;padding:9px;border-radius:7px}.lo-explorer .sx-status{border-top:1px solid var(--sx-line);padding-top:8px}.lo-explorer .sx-status strong{color:var(--sx-ink)}.lo-explorer .sx-flow{display:flex;flex-wrap:wrap;align-items:center;gap:7px;font-size:.78rem;color:var(--sx-muted);margin:0 0 12px}.lo-explorer .sx-flow span{padding:5px 7px;background:#edf3f9;border-radius:6px;color:var(--sx-ink);font-weight:650}.lo-explorer .sx-note{padding-top:6px}.lo-explorer .sx-foot{margin-top:12px;font-size:.83rem;color:var(--sx-muted)}.lo-explorer .sx-demo{font-size:.78rem;font-weight:700;color:#74420e;background:#fff4df;padding:8px 12px;border-radius:8px}\n@media(max-width:400px){.lo-explorer .sx-group{padding:10px}.lo-explorer .sx-card summary{min-height:64px}}\n";
function esc(value){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function serviceStatus(s,mode,capabilities){
 if(mode==="pre")return {label:s.pre,detail:""};
 if(mode==="demo")return {label:"Example only · No live account",detail:s.post};
 const cap=s.cap&&capabilities?.[s.cap];
 if(cap&&Object.hasOwn(STATES,cap.state))return {label:STATES[cap.state],detail:typeof cap.detail==="string"?cap.detail:s.post};
 return {label:s.id==="r2"?"Future extension":"Individual status not verified",detail:s.post};
}
function card(s,mode,capabilities){
 const status=serviceStatus(s,mode,capabilities);
 const icon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+ICONS[s.icon]+'</svg>';
 return '<details class="sx-card sx-'+s.id+'"><summary><span class="sx-icon">'+icon+'</span><span class="sx-label"><strong>'+esc(s.name)+'</strong><small>'+esc(s.role)+'</small></span></summary><div class="sx-detail"><p>'+esc(s.description)+'</p><p class="sx-example"><strong>Example:</strong> '+esc(s.example)+'</p><p class="sx-status"><strong>'+esc(status.label)+'</strong>'+(status.detail?' — '+esc(status.detail):'')+'</p></div></details>';
}
export function serviceExplorerMarkup({mode="pre",capabilities={}}={}){
 if(!["pre","toolkit","demo"].includes(mode))throw new TypeError("Unknown service explorer mode");
 const group=(id,title,note,flow)=>'<div class="sx-group"><div class="sx-group-title"><h3>'+title+'</h3><span>'+note+'</span></div>'+(flow||"")+'<div class="sx-grid">'+SERVICES.filter(s=>s.group===id).map(s=>card(s,mode,capabilities)).join("")+'</div></div>';
 const pre=mode==="pre";
 return '<div class="lo-explorer"><div class="sx-head"><h2>'+(pre?'Explore your digital ecosystem':'Your website services')+'</h2><p>'+(pre?'Click any service to see what it does, why it matters and when you might need it. Only GitHub and Cloudflare accounts are required for a basic launch.':'Click a service to learn what it does and review the available setup information. Individual resource status is not inferred from another service.')+'</p>'+(mode==="demo"?'<p class="sx-demo">Toolkit design preview — no real account or resource status.</p>':'')+'</div>'+
 group("foundation","01 · Website foundation","Required for basic launch",'<div class="sx-flow" aria-label="GitHub sends approved files to Cloudflare Pages, then visitors see the site"><span>GitHub</span> → <span>Cloudflare Pages</span> → <span>Your website</span></div>')+
 group("forms","02 · Contact forms &amp; private tools","Optional · separate approval and verification",'<div class="sx-flow" aria-label="Visitor submits a form; Turnstile and Workers validate; D1 stores; Access protects a separate admin view"><span>Visitor submits</span> → <span>Turnstile + Workers validate</span> → <span>D1 stores</span></div><p class="sx-note">Access can protect a separate admin view; it does not process or store form submissions.</p>')+
 group("growth","03 · Grow your business","Optional or future capabilities","")+
 '<p class="sx-foot">'+(pre?'No optional resources are created just by exploring. Free tiers are subject to provider limits; additional services and domains may cost money.':'Use the existing site options and provider review links for supported setup. Optional features are not automatically enabled; recorded statuses do not prove current provider configuration.')+'</p></div>';
}
