/** Signed-out landing: marketing first, real setup (existing provider cards) at #get-started. Presentation only.
 * Owns the Launch/Maintain/Grow tab composition; #164 owns marketing-pipeline.mjs and ai-update-journey.mjs, consumed unchanged.
 * Taste pass: software marketing layout under Worker CSP (inline CSS only; no remote fonts, images, or scripts). */
import {marketingPipelineCss,marketingPipelineMarkup} from './marketing-pipeline.mjs';
import {aiUpdateJourneyMarkup} from './ai-update-journey.mjs';
import {serviceExplorerMarkup} from './service-explorer.mjs';

// CSS-only tabs (CSP has no script-src). Without :has() support every panel stays visible, so nothing is lost.
const tabsCss = `
.lo-marketing .lo-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.lo-marketing .lo-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 22px;padding:6px;border:1px solid var(--line);border-radius:16px;background:#fff;min-width:0}
.lo-marketing .lo-tab{position:relative;display:grid;gap:1px;padding:12px 14px;border-radius:11px;cursor:pointer;min-width:0;transition:background .15s ease,transform .12s ease}
.lo-marketing .lo-tab:hover{background:#f0f4fa}
.lo-marketing .lo-radio{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.lo-marketing .lo-tab-label{font-weight:800;font-size:1.02rem}.lo-marketing .lo-tab-hint{font-size:.8rem;color:var(--muted)}
.lo-marketing .lo-tab:has(.lo-radio:checked){background:var(--blue);color:#fff}.lo-marketing .lo-tab:has(.lo-radio:checked) .lo-tab-hint{color:#F0F7FF}
.lo-marketing .lo-tab:has(.lo-radio:focus-visible){outline:3px solid var(--blue);outline-offset:3px}
.lo-marketing:has(.lo-radio:checked) .lo-panel{display:none}
.lo-marketing:has(#lo-tab-launch:checked) .lo-p-launch,.lo-marketing:has(#lo-tab-maintain:checked) .lo-p-maintain,.lo-marketing:has(#lo-tab-grow:checked) .lo-p-grow{display:block}
.lo-marketing .lo-panel{margin:0;padding:0;border:0}.lo-marketing .lo-panel-head{display:grid;gap:10px;margin-bottom:22px}
.lo-marketing .lo-panel-head h3{font-size:clamp(1.6rem,3.6vw,2.4rem);letter-spacing:-.04em;line-height:1.1}
.lo-marketing .lo-panel .lo-explorer{margin-top:0}
.lo-marketing .lo-p-maintain .lo-ai{margin:28px 0 8px}
.lo-marketing .lo-editor{margin:0 0 22px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:clamp(16px,3vw,24px);display:grid;gap:14px;justify-items:stretch}
.lo-marketing .lo-editor>h3{margin:0;font-size:clamp(1.25rem,2.4vw,1.55rem);letter-spacing:-.03em}
.lo-marketing .lo-editor>.lo-editor-lede{margin:0;color:var(--muted);font-size:.95rem;max-width:62ch;line-height:1.45}
.lo-marketing .lo-editor>.lo-path-badge{justify-self:start}
.lo-marketing .lo-ve-shot{border-radius:12px;overflow:hidden;border:1px solid #1a1a1a;background:#0a0a0a;box-shadow:0 18px 40px #0a0a0a33;min-width:0}
.lo-marketing .lo-ve-top{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#111;color:#c9c9c9;font-size:.68rem;font-weight:700;letter-spacing:.04em;flex-wrap:wrap}
.lo-marketing .lo-ve-top .on{background:#fff;color:#111;border-radius:6px;padding:3px 8px}
.lo-marketing .lo-ve-top .off{opacity:.7;padding:3px 6px}
.lo-marketing .lo-ve-top .file{margin-right:auto;opacity:.85}
.lo-marketing .lo-ve-body{display:grid;grid-template-columns:132px minmax(0,1fr) 128px;min-height:220px;background:#0a0a0a}
.lo-marketing .lo-ve-side{padding:10px;color:#bdbdbd;font-size:.68rem;border-right:1px solid #222}
.lo-marketing .lo-ve-side.right{border-right:0;border-left:1px solid #222}
.lo-marketing .lo-ve-tabs{display:flex;gap:8px;margin-bottom:10px;color:#888}
.lo-marketing .lo-ve-tabs span:first-child{color:#fff;border-bottom:2px solid #fff;padding-bottom:2px}
.lo-marketing .lo-ve-blocks{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.lo-marketing .lo-ve-blocks i{display:block;border:1px solid #333;border-radius:5px;padding:7px 4px;text-align:center;font-style:normal;background:#161616;color:#ddd}
.lo-marketing .lo-ve-canvas{background:#eceff3;padding:18px;display:grid;align-content:start;gap:8px}
.lo-marketing .lo-ve-page{background:#fff;border:1px solid #d5dbe3;border-radius:8px;padding:18px 16px;display:grid;gap:8px;box-shadow:0 8px 20px #15243a14}
.lo-marketing .lo-ve-page strong{font:700 1.35rem/1.15 Georgia,serif;color:#1d4ed8}
.lo-marketing .lo-ve-page b{font-size:.92rem;color:#0f172a}
.lo-marketing .lo-ve-page em{font-style:normal;color:#2563eb;text-decoration:underline;font-size:.88rem}
.lo-marketing .lo-ve-page .sel{outline:2px solid #2563eb;outline-offset:3px;border-radius:2px}
.lo-marketing .lo-ve-hint{margin:8px 0 0;color:#777;font-size:.68rem;line-height:1.4}
.lo-marketing .lo-ve-foot{display:flex;justify-content:flex-end;padding:6px 12px;background:#111;color:#888;font-size:.65rem}
.lo-marketing .lo-editor-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.lo-marketing .lo-editor-steps li{display:grid;gap:4px;padding:12px;border-radius:12px;background:#f8fafc;border:1px solid var(--line);min-width:0}
.lo-marketing .lo-editor-steps b{color:var(--blue);font-size:.72rem;letter-spacing:.04em}
.lo-marketing .lo-editor-steps strong{font-size:.9rem}.lo-marketing .lo-editor-steps p{margin:0;font-size:.82rem;color:var(--muted);line-height:1.45}
.lo-marketing .lo-editor details{margin:0;padding-top:4px;border-top:1px solid var(--line)}
.lo-marketing .lo-editor summary{cursor:pointer;color:var(--blue);font-weight:750;font-size:.9rem}
.lo-marketing .lo-editor details p,.lo-marketing .lo-editor details ul{margin:8px 0 0;color:var(--muted);font-size:.88rem;line-height:1.5}
.lo-marketing .lo-editor details ul{padding-left:18px}
@media(max-width:700px){.lo-marketing .lo-ve-body{grid-template-columns:1fr}.lo-marketing .lo-ve-side{display:none}}
.lo-marketing .lo-paths{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}
.lo-marketing .lo-path{background:#fff;border:1px solid var(--line);border-radius:15px;padding:18px;display:grid;gap:8px;align-content:start;transition:transform .15s ease,box-shadow .15s ease}
.lo-marketing .lo-path:hover{transform:translateY(-2px);box-shadow:var(--shadow)}
.lo-marketing .lo-path p{color:var(--muted);font-size:.9rem}.lo-marketing .lo-path-badge{justify-self:start;font-size:.72rem;font-weight:800;border-radius:999px;padding:2px 10px;background:#e0f4ec;color:var(--green)}
.lo-marketing .lo-path-badge.plan{background:#fff4dc;color:#8a5300}
.lo-marketing .lo-asst{margin-top:18px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:clamp(16px,3vw,22px)}
.lo-marketing .lo-asst>h3{margin:0 0 12px;font-size:1.1rem}
.lo-marketing .lo-asst-steps{list-style:none;margin:0 0 8px;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.lo-marketing .lo-asst-steps li{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start;padding:10px;border-radius:12px;background:#f8fafc}
.lo-marketing .lo-asst-steps p{margin:2px 0 0;font-size:.85rem;color:var(--muted)}
.lo-marketing .lo-asst-n{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#fff4dc;color:#8a5300;font-weight:800;font-size:.85rem}
.lo-marketing .lo-asst ul{margin:0;padding-left:18px;color:var(--muted);font-size:.9rem}
@media(max-width:900px){.lo-marketing .lo-asst-steps,.lo-marketing .lo-editor-steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.lo-marketing .lo-asst-steps,.lo-marketing .lo-editor-steps{grid-template-columns:1fr}.lo-marketing .lo-tabs{grid-template-columns:1fr}.lo-marketing .lo-tab{grid-template-columns:auto 1fr;align-items:baseline;column-gap:10px}.lo-marketing .lo-paths{grid-template-columns:1fr}}
`;

export const landingCss = marketingPipelineCss + tabsCss + `
.lp{display:grid;gap:clamp(48px,8vw,96px);max-width:1024px;margin:0 auto}
.lp-hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:clamp(28px,5vw,56px);align-items:center;min-height:min(78vh,720px);padding:clamp(8px,3vw,28px) 0 0}
.lp-hero[data-enter]{animation:lp-enter .7s ease both}
@keyframes lp-enter{from{transform:translateY(12px)}to{transform:none}}
@media(prefers-reduced-motion:reduce){.lp-hero[data-enter]{animation:none}}
.lp-kicker{margin:0;font-size:.78rem;letter-spacing:.13em;font-weight:800;text-transform:uppercase;color:var(--blue)}
.lp-hero h1{margin:10px 0 14px;font-size:clamp(2.4rem,6.4vw,4.4rem);line-height:1.02;letter-spacing:-.055em}
.lp-lede{margin:0 0 22px;font-size:clamp(1.05rem,2vw,1.18rem);color:var(--muted);max-width:36rem;line-height:1.45}
.lp-ctas{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:22px}
.lp-ctas .btn{min-height:50px;padding:12px 22px;font-size:1.02rem;transition:transform .12s ease,background .15s ease}
.lp-ctas .btn:hover{transform:translateY(-1px)}.lp-ctas .btn:active{transform:translateY(1px)}
.lp-points{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:.92rem;color:var(--muted)}
.lp-points li::before{content:"✓";color:var(--green);font-weight:800;margin-right:8px}
.lp-art{display:grid;gap:14px;align-content:center}
.lp-window{border:1px solid #c7d4e2;border-radius:16px;background:#fff;box-shadow:0 24px 60px #15243a1f;overflow:hidden;transition:transform .2s ease,box-shadow .2s ease}
.lp-window:hover{transform:translateY(-2px);box-shadow:0 28px 64px #15243a24}
.lp-bar{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#eef3f8;border-bottom:1px solid var(--line)}
.lp-bar i{width:9px;height:9px;border-radius:50%;background:#c3cfdc}.lp-bar span{margin-left:8px;font-size:.74rem;color:#4a5d74;background:#fff;border-radius:999px;padding:2px 10px}
.lp-site{padding:22px;display:grid;gap:12px;background:linear-gradient(160deg,#e6f1ec,#f6faf8)}
.lp-site strong{font:700 1.5rem/1.1 Georgia,serif;color:#1f4c3e}.lp-site p{margin:0;color:#3d6658;font-size:.9rem}
.lp-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.lp-tiles span{background:#fff;border:1px solid #d3e4dc;border-radius:9px;padding:9px;font-size:.74rem;color:#2c5a4b;font-weight:650}
.lp-art-meta{margin:0;display:flex;flex-wrap:wrap;gap:8px 16px;font-size:.82rem;font-weight:650;color:var(--muted)}
.lp-art-meta span{display:inline-flex;align-items:center;gap:6px}
.lp-art-meta b{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;font-size:.68rem;background:var(--surface-low,#F1F5F9);color:var(--ink)}
.lp-art-meta .ok b{background:var(--green-soft);color:var(--green)}
.lp-art-meta .cf b{background:var(--orange-soft);color:var(--orange)}
.lp-own{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;list-style:none;margin:0;padding:0}
.lp-own li{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;display:grid;gap:4px;transition:transform .15s ease,box-shadow .15s ease}
.lp-own li:hover{transform:translateY(-2px);box-shadow:var(--shadow)}
.lp-own strong{font-size:1.05rem}.lp-own span{color:var(--muted);font-size:.92rem}
.lp-sec{scroll-margin-top:80px;padding:clamp(8px,2vw,16px) 0}
.lp-sec-head{display:grid;gap:8px;margin-bottom:18px;max-width:40rem}.lp-sec-head h2{margin:0;font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.045em;line-height:1.1}.lp-sec-head p{margin:0;color:var(--muted);font-size:1.02rem}
.lp-faq details{background:#fff;padding:14px 18px;transition:box-shadow .15s ease}.lp-faq details:hover{box-shadow:var(--shadow)}
.lp-faq-a{margin-top:8px;color:var(--muted)}.lp-faq-a p{margin:0 0 8px}
.lp-start{background:#fff;border:1px solid var(--line);border-radius:22px;padding:clamp(18px,4vw,40px);box-shadow:var(--shadow);scroll-margin-top:80px}
.lp-start .provider-guides{margin-top:0}
.lp-final{text-align:center;display:grid;justify-items:center;gap:12px;padding:clamp(32px,6vw,56px);border-radius:22px;background:#18334f;color:#fff}
.lp-final h2{margin:0;font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:-.04em}.lp-final p{margin:0;color:#d0e3fa;max-width:36rem}
.lp-final .btn{background:#fff;color:#18334f;border-color:#fff;transition:transform .12s ease,background .15s ease}
.lp-final .btn:hover{background:#e6eefb;color:#18334f;transform:translateY(-1px)}.lp-final .btn:active{transform:translateY(1px)}
#explore,#faq{scroll-margin-top:80px}
.lp .lo-marketing{max-width:none;padding:0;background:transparent;border-radius:0}
.lp .lo-marketing .lo-hero h2{font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.045em;max-width:44rem}
@media(max-width:900px){.lp-hero{grid-template-columns:1fr;min-height:0}.lp-art{max-width:520px}}
@media(max-width:700px){.lp-own{grid-template-columns:1fr}}
`;

/** What the verified ZIP import accepts today (onboarding/website-zip.mjs). Shared by the landing page and the upload form. */
export const zipCompatibilityHtml =
  '<div class="lp-compat"><div class="ok"><strong>Works today</strong><ul><li>A finished, built website with <code>index.html</code> at the top or in one folder</li><li>HTML, CSS, JavaScript, images and fonts</li><li>Up to 6 MB zipped, 128 files</li><li>Publishes after checks. After launch, make simple text, link, contact and color updates from your toolkit (beta)</li></ul></div>'+
  '<div class="limited"><strong>Compiled sites</strong><ul><li>Compiled or minified sites (for example a Vite <code>dist</code> folder) can publish exactly as uploaded once they pass the same checks</li><li>Edit them with your own AI coding tool. Toolkit updates work on plain HTML and CSS files, not compiled ones</li></ul></div>'+
  '<div class="no"><strong>Not supported yet</strong><ul><li>Unbuilt project source (<code>package.json</code>, React or Vite source before building)</li><li>Sites that need a server, database or build step</li></ul></div></div>';

// Name lives on the radio; the visible spans are hidden from assistive tech so screen readers announce each tab once.
const tab=(id,label,hint,checked)=>'<label class="lo-tab"><input class="lo-radio" type="radio" name="lo-explore" id="lo-tab-'+id+'" value="'+id+'" aria-label="'+label+': '+hint+'"'+(checked?' checked':'')+'><span class="lo-tab-label" aria-hidden="true">'+label+'</span><span class="lo-tab-hint" aria-hidden="true">'+hint+'</span></label>';

// Hosted visual HTML editor (site-editor) is available in hosted beta. Own AI tools stay available. Customer-owned assistant stays planned (#165).
// Decorative mock only (CSP has no img-src): mirrors the real Visual / Source editor chrome without scripts or screenshots.
const editorShot =
  '<div class="lo-ve-shot" aria-hidden="true">'+
  '<div class="lo-ve-top"><span class="file">INDEX.HTML</span><span class="on">Visual</span><span class="off">Source</span><span class="off">Desktop</span><span class="off">Preview</span></div>'+
  '<div class="lo-ve-body"><div class="lo-ve-side"><div class="lo-ve-tabs"><span>Blocks</span><span>Tree</span><span>Assets</span></div>'+
  '<div class="lo-ve-blocks"><i>H1</i><i>H2</i><i>Paragraph</i><i>Divider</i></div></div>'+
  '<div class="lo-ve-canvas"><div class="lo-ve-page"><strong class="sel">Example Bakery</strong><b>Saturday: 9 AM–2 PM</b><em>Contact us</em></div></div>'+
  '<div class="lo-ve-side right"><div class="lo-ve-tabs"><span>Style</span><span>Attributes</span><span>HTML</span></div>'+
  '<p class="lo-ve-hint">Select an element to edit its style.</p></div></div>'+
  '<div class="lo-ve-foot">Autosaved · nothing published yet</div></div>';

const maintainEditor =
  '<article class="lo-editor" aria-labelledby="lo-editor-title">'+
  '<p class="lo-path-badge">Available · hosted beta</p>'+
  '<h3 id="lo-editor-title">Built-in visual HTML editor</h3>'+
  '<div class="lo-editor-lede">After a live launch, open your toolkit and edit the real page in a full visual HTML editor — Visual and Source modes, blocks, styles, and a live canvas. Change text on the page, then choose Preview. Nothing goes live until you approve that exact change, or open a pull request and merge it yourself.</div>'+
  editorShot+
  '<ol class="lo-editor-steps" aria-label="How the visual editor works">'+
  [['01 · Open','Your toolkit','Sign in and open Updates for the live site you own.'],
   ['02 · Edit','Visual HTML editor','Click the page, swap text and links, or switch to Source. Hosting files stay off-limits.'],
   ['03 · Preview','Exact private preview','See the changed pages before anything goes public.'],
   ['04 · Decide','Approve or pull request','Approve that exact version to publish, or open a pull request and merge it yourself.']]
    .map(([b,t,d])=>'<li><b>'+b+'</b><strong>'+t+'</strong><p>'+d+'</p></li>').join('')+
  '</ol>'+
  '<details><summary>What can the visual editor change today?</summary>'+
  '<ul><li><strong>Uploaded websites:</strong> edit plain HTML and CSS pages in the visual editor — text, links, contact details, and colors. Publishing still goes through preview and your approval.</li>'+
  '<li><strong>Simple one-page sites:</strong> a guided form for headline, about copy, services, theme, and optional contact email.</li>'+
  '<li>Compiled or minified bundles stay read-only here; edit those with your own coding tool.</li>'+
  '<li>Nothing publishes until you approve the exact preview, or merge a pull request yourself.</li></ul></details></article>';

// Other Maintain paths (own AI tools + planned assistant). The #164 AI journey sits between the editor and these.
const maintainOtherPaths =
  '<div class="lo-paths" aria-label="Other ways to make changes">'+
  '<article class="lo-path"><span class="lo-path-badge">Available with your own tools</span><h3>Your own AI coding tool</h3><p>Use Codex, Claude Code, or another GitHub coding tool that can write to your repo. Read-only ChatGPT GitHub access cannot push.</p><p>Ask for a branch and a pull request. Do not let it write straight to your production branch.</p></article>'+
  '<article class="lo-path"><span class="lo-path-badge plan">Planned · not released</span><h3>Your own website assistant</h3><p>A private assistant you would set up in your own GitHub and Cloudflare accounts. Ask in plain words, preview the exact change, then approve once to publish. Or open a pull request and merge it yourself.</p><p>Launch &amp; Own would have no access to it. It is not available yet, and no release date is promised.</p></article></div>'+
  '<div class="lo-asst"><h3 id="lo-asst-title">How the planned assistant would work</h3>'+
  '<ol class="lo-asst-steps">'+
  [['Ask','Describe the change, such as new Saturday hours.'],['Prepare','It prepares the change on a separate branch. Your live site is untouched.'],['Preview','You see an exact private preview of the changed pages.'],['Approve','You approve that exact version. The approval works once and expires after 15 minutes.'],['Merge','Approving merges that exact change into your site\'s main branch, only if nothing changed since the preview. Or choose a pull request and merge it yourself.'],['Publish and check','Cloudflare publishes the merged files and the assistant checks the live site.']]
    .map(([t,d],i)=>'<li><span class="lo-asst-n" aria-hidden="true">'+(i+1)+'</span><div><strong>'+t+'</strong><p>'+d+'</p></div></li>').join('')+'</ol>'+
  '<details><summary>What could it change first?</summary><p>Up to 10 changes in up to 5 files — text, links, business details and colors — from a short request when that path is turned on. Changes still go through an exact preview and your approval. Anything that would touch code is refused, and every other file stays exactly the same.</p></details>'+
  '<details><summary>What stays in your control?</summary><ul>'+
  '<li>You run the setup in your own accounts and review everything it would create first. The Grow tab lists those resources.</li>'+
  '<li>Only you can sign in to it.</li>'+
  '<li>It merges only the exact change you just approved, and only if your site has not changed since the preview. It cannot change repository settings, edit workflows or create other resources.</li>'+
  '<li>Security fixes and other urgent assistant updates would come as pull requests for you to review, or as a notice if you prefer.</li>'+
  '<li>On Cloudflare\'s free plan, it stops for the day at the daily AI limit instead of charging you. On a paid plan, Cloudflare bills usage above the included amount.</li>'+
  '<li>You can remove it at any time without touching your website.</li></ul></details></div>';

/** Grow: resources the planned assistant would add in the customer's own accounts (design #170). Planned, never shown as active. */
const ASSISTANT_RESOURCES=[
  ['GitHub','Assistant repository','A private repository for the assistant\'s own code, separate from your website so it can never end up on your public site.'],
  ['GitHub','Private GitHub app','Created for you alone and installed only on your website repository. It can read files, open pull requests and merge a change you just approved. It cannot change settings or edit workflows.'],
  ['Cloudflare','Workers','Run the assistant and a separate preview in your Cloudflare account.'],
  ['Cloudflare','D1 database','Keeps your requests, previews and approvals. Uses 1 of the databases included in Cloudflare\'s free plan.'],
  ['Cloudflare','Workers AI','Reads your request and proposes the change, using your account\'s daily AI allowance.'],
  ['Cloudflare','Access','Lets only you sign in to the assistant. You set this up in the Cloudflare dashboard.']
];
const assistantResources='<div class="lo-explorer"><div class="sx-group"><div class="sx-group-title"><h3 id="lo-grow-asst">04 · Your private website assistant</h3><span>Planned · not released · created only by you</span></div>'+
  '<p class="sx-note">When it is released, setting up the assistant would add these to your own accounts. These are separate from the Workers, D1 and Access a contact form uses.</p><div class="sx-grid">'+
  ASSISTANT_RESOURCES.map(([provider,name,detail])=>'<details class="sx-card"><summary><span class="sx-label"><strong>'+name+'</strong><small>'+provider+' · planned</small></span></summary><div class="sx-detail"><p>'+detail+'</p></div></details>').join('')+
  '</div><p class="sx-foot">Nothing here exists yet, and exploring creates nothing. Before setup you would see everything it creates and the provider limits. On free plans it stops at a daily limit instead of charging you; on paid plans the provider bills you directly. You can remove it all without touching your website.</p></div></div>';

/** Tabbed explorer built from #164's components (consumed unchanged). */
export function exploreMarkup({zipEnabled=false}={}){
  const pipeline=marketingPipelineMarkup({zipEnabled});
  const journey=aiUpdateJourneyMarkup();
  const from=pipeline.indexOf('<ol class="lo-flow"'), to=pipeline.indexOf(journey), foot=pipeline.indexOf('<div class="lo-footer">');
  // shortcut: slices #164's markup by stable markers; ask #164 for a launchFlowMarkup() export if this ever breaks (test guards it).
  if(from<0||to<from||foot<to)throw Error('marketing-pipeline markup changed; update exploreMarkup');
  const lede=zipEnabled
    ?'Bring a finished website, or create a simple one here. We help you connect accounts, show a private preview, and publish only when you approve.'
    :'Create a website and publish it in accounts you own. We help you connect, show a private preview, and publish only when you approve.';
  return '<div class="lo-marketing" id="explore" aria-labelledby="lo-explore-title"><div class="lo-hero"><p class="lo-kicker">How it works</p><h2 id="lo-explore-title">Launch today. Improve any time. Grow when you are ready.</h2></div>'+
    '<fieldset class="lo-tabs"><legend class="lo-sr">Choose what to explore</legend>'+
    tab('launch','Launch','Get your business online',true)+tab('maintain','Maintain','Visual HTML editor')+tab('grow','Grow','Grow beyond a website')+'</fieldset>'+
    '<section class="lo-panel lo-p-launch" aria-labelledby="lo-launch-title"><div class="lo-panel-head"><h3 id="lo-launch-title">Get your business online.</h3><p class="lo-lede">'+lede+'</p><div class="lo-trust"><span>No code needed for a simple site</span><span>Nothing publishes without your approval</span><span>Your files stay yours</span></div></div>'+
    pipeline.slice(from,to)+
    (zipEnabled?'<details><summary>What kind of website can I bring?</summary>'+zipCompatibilityHtml+'</details>':'')+'</section>'+
    '<section class="lo-panel lo-p-maintain" aria-labelledby="lo-maintain-title"><div class="lo-panel-head"><h3 id="lo-maintain-title">Make changes after launch.</h3><p class="lo-lede">Use the built-in visual HTML editor in your toolkit — edit the page like a design canvas, or switch to Source. Or work in your own GitHub with an AI coding tool. A private assistant you run yourself is planned and not released yet.</p><div class="lo-trust"><span>Visual HTML editor · hosted beta</span><span>Exact preview before publish</span><span>Approve or open a pull request</span></div></div>'+
    maintainEditor+journey+maintainOtherPaths+'</section>'+
    '<section class="lo-panel lo-p-grow" aria-label="Grow beyond a website">'+serviceExplorerMarkup()+assistantResources+'</section>'+
    pipeline.slice(foot,pipeline.lastIndexOf('</div>'))+'</div>';
}

const faq = zipEnabled => [
  ...(zipEnabled?[['What kind of website can I bring?','Finished, built websites work best: an <code>index.html</code> with its HTML, CSS, JavaScript, images and fonts, zipped. Unbuilt project source, such as a React or Vite project before building, is not supported yet.',zipCompatibilityHtml]]:[]),
  ['What will I connect, and what can Launch &amp; Own do?','You sign in to GitHub and install the Launch &amp; Own GitHub app so it can create a private repository for your website files. You connect Cloudflare and pick the account that hosts the site. Cloudflare also needs its own Workers &amp; Pages GitHub app with access to that repository. Each provider shows you the permissions before you agree. No repository or hosting project is created until you approve the exact preview.'],
  ['What does it cost?','GitHub and Cloudflare offer free plans that suit many simple sites, within their limits. Launch &amp; Own does not sell you hosting. A custom domain or extras may cost money from the provider you choose.'],
  ['Can I use my own domain?','Your site launches on a free <code>pages.dev</code> address. After launch you can save a custom domain request from your toolkit. Saving it does not change DNS. Each step needs your review and approval.'],
  ['Can I edit my website after launch?','Yes. After a live launch, open your website toolkit. Uploaded sites open in a built-in visual HTML editor (Visual and Source modes) so you can change the page on a live canvas. Simple one-page sites use a guided form. You always preview the exact change, then approve to publish or open a pull request instead. Compiled bundles stay read-only in the toolkit.'],
  ['Can AI update my website?','You can also use your own AI coding tool with write access, such as Codex or Claude Code, to open pull requests you review and merge. A private assistant in your own GitHub and Cloudflare accounts is planned and has not been released. It would never approve for you. It would publish only after you approve that exact version.'],
  ['What happens if I stop using Launch &amp; Own?','Your files stay in your GitHub repository. Your site stays in your Cloudflare account. Disconnect any time and remove app access in each provider\'s settings.']
];

/** setupHtml: trusted server-rendered setup (notices + existing provider connection cards). */
export function landingMarkup({zipEnabled=false,setupHtml=''}={}) {
  const zip=zipEnabled===true;
  const hero=zip
    ?'<p class="lp-kicker">Build anywhere. Own everything.</p><h1 id="lp-title">Your website.<br>Your rules.</h1>'+
      '<p class="lp-lede">Built a site with ChatGPT, Claude, or another tool? Upload the finished ZIP. We check it, show a private preview, and publish into GitHub and Cloudflare accounts you own.</p>'+
      '<div class="lp-ctas"><a class="btn" href="#get-started">Bring my website</a><a class="btn btn-secondary" href="#get-started">No site yet? Create one</a></div>'+
      '<ul class="lp-points"><li>Finished static websites with an index.html</li><li>Your own GitHub and Cloudflare accounts, free plans within provider limits</li><li>Nothing publishes without your approval</li></ul>'
    :'<p class="lp-kicker">Describe it. Launch it. Own it.</p><h1 id="lp-title">Your website.<br>Your rules.</h1>'+
      '<p class="lp-lede">Publish a simple website into your own GitHub and Cloudflare accounts. You see a private preview first. Nothing goes live until you approve it.</p>'+
      '<div class="lp-ctas"><a class="btn" href="#get-started">Launch my website</a><a class="btn btn-secondary" href="#explore">See how it works</a></div>'+
      '<ul class="lp-points"><li>Your own GitHub and Cloudflare accounts</li><li>Free plans for many simple sites, within provider limits</li><li>Nothing publishes without your approval</li></ul>';
  return '<div class="lp">'+
    '<section class="lp-hero" data-enter aria-labelledby="lp-title"><div>'+hero+'</div>'+
    '<div class="lp-art" aria-hidden="true"><div class="lp-window"><div class="lp-bar"><i></i><i></i><i></i><span>your-business.pages.dev</span></div>'+
    '<div class="lp-site"><strong>Green Willow Studio</strong><p>Portraits, events, and editing downtown.</p><div class="lp-tiles"><span>Portraits</span><span>Events</span><span>Editing</span></div></div></div>'+
    '<p class="lp-art-meta"><span><b>GH</b>Your files · GitHub</span><span class="cf"><b>CF</b>Your hosting · Cloudflare</span><span class="ok"><b>✓</b>Approved by you</span></p></div></section>'+
    exploreMarkup({zipEnabled:zip})+
    '<section class="lp-sec" aria-labelledby="lp-own-title"><div class="lp-sec-head"><h2 id="lp-own-title">You stay in control</h2><p>Accounts, hosting, and go-live decisions stay with you.</p></div><ul class="lp-own">'+
    '<li><strong>Your accounts</strong><span>Files in your GitHub. Hosting in your Cloudflare.</span></li>'+
    '<li><strong>Low-cost options</strong><span>Free provider plans for many simple sites. Extras are optional.</span></li>'+
    '<li><strong>Your approval</strong><span>You see the exact preview and decide what goes live.</span></li></ul></section>'+
    '<section id="faq" class="lp-faq lp-sec" aria-labelledby="lp-faq-title"><div class="lp-sec-head"><h2 id="lp-faq-title">Questions</h2></div>'+
    faq(zip).map(([q,a,extra=''])=>'<details><summary>'+q+'</summary><div class="lp-faq-a"><p>'+a+'</p>'+extra+'</div></details>').join('')+'</section>'+
    '<section id="get-started" class="lp-start" aria-labelledby="lp-start-title"><div class="lp-sec-head"><p class="lp-kicker">Get started</p><h2 id="lp-start-title">Start your launch</h2><p>'+
    (zip?'Upload a website you already built, or create a simple one here.':'Create a simple website here.')+
    ' Connect GitHub first, then Cloudflare. Returning owners sign in the same way to open their toolkit and launch history.</p></div>'+setupHtml+'</section>'+
    '<section class="lp-final" aria-labelledby="lp-final-title"><h2 id="lp-final-title">Ready when you are</h2><p>Describe it. Launch it. Own it.</p><a class="btn" href="#get-started">'+(zip?'Bring my website':'Launch my website')+'</a></section>'+
    '</div>';
}
