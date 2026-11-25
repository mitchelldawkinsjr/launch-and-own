/** Signed-out landing: marketing first, real setup (existing provider cards) at #get-started. Presentation only.
 * Owns the Launch/Maintain/Grow tab composition; #164 owns marketing-pipeline.mjs and ai-update-journey.mjs, consumed unchanged. */
import {marketingPipelineCss,marketingPipelineMarkup} from './marketing-pipeline.mjs';
import {aiUpdateJourneyMarkup} from './ai-update-journey.mjs';
import {serviceExplorerMarkup} from './service-explorer.mjs';

// CSS-only tabs (CSP has no script-src). Without :has() support every panel stays visible, so nothing is lost.
const tabsCss = `
.lo-marketing .lo-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.lo-marketing .lo-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 22px;padding:6px;border:1px solid var(--line);border-radius:16px;background:#fff;min-width:0}
.lo-marketing .lo-tab{position:relative;display:grid;gap:1px;padding:12px 14px;border-radius:11px;cursor:pointer;min-width:0}
.lo-marketing .lo-tab:hover{background:#f0f4fa}
.lo-marketing .lo-radio{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.lo-marketing .lo-tab-label{font-weight:800;font-size:1.02rem}.lo-marketing .lo-tab-hint{font-size:.8rem;color:var(--muted)}
.lo-marketing .lo-tab:has(.lo-radio:checked){background:var(--blue);color:#fff}.lo-marketing .lo-tab:has(.lo-radio:checked) .lo-tab-hint{color:#dce8ff}
.lo-marketing .lo-tab:has(.lo-radio:focus-visible){outline:3px solid var(--blue);outline-offset:3px}
.lo-marketing:has(.lo-radio:checked) .lo-panel{display:none}
.lo-marketing:has(#lo-tab-launch:checked) .lo-p-launch,.lo-marketing:has(#lo-tab-maintain:checked) .lo-p-maintain,.lo-marketing:has(#lo-tab-grow:checked) .lo-p-grow{display:block}
.lo-marketing .lo-panel{margin:0;padding:0;border:0}.lo-marketing .lo-panel-head{display:grid;gap:10px;margin-bottom:22px}
.lo-marketing .lo-panel-head h3{font-size:clamp(1.6rem,3.6vw,2.4rem);letter-spacing:-.04em;line-height:1.1}
.lo-marketing .lo-panel .lo-ai,.lo-marketing .lo-panel .lo-explorer{margin-top:0}
.lo-marketing .lo-paths{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}
.lo-marketing .lo-path{background:#fff;border:1px solid var(--line);border-radius:15px;padding:18px;display:grid;gap:8px;align-content:start}
.lo-marketing .lo-path p{color:var(--muted);font-size:.9rem}.lo-marketing .lo-path-badge{justify-self:start;font-size:.72rem;font-weight:800;border-radius:999px;padding:2px 10px;background:#e0f4ec;color:var(--green)}
.lo-marketing .lo-path-badge.plan{background:#fff4dc;color:#8a5300}
@media(max-width:700px){.lo-marketing .lo-tabs{grid-template-columns:1fr}.lo-marketing .lo-tab{grid-template-columns:auto 1fr;align-items:baseline;column-gap:10px}.lo-marketing .lo-paths{grid-template-columns:1fr}}
`;

export const landingCss = marketingPipelineCss + tabsCss + `
.lp{display:grid;gap:clamp(36px,6vw,72px)}
.lp-hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:clamp(24px,5vw,56px);align-items:center;padding:clamp(12px,4vw,40px) 0 0}
.lp-kicker{margin:0;font-size:.78rem;letter-spacing:.13em;font-weight:800;text-transform:uppercase;color:var(--blue)}
.lp-hero h1{margin:10px 0 14px;font-size:clamp(2.4rem,6.4vw,4.4rem);line-height:1.02;letter-spacing:-.055em}
.lp-lede{margin:0 0 22px;font-size:clamp(1.05rem,2vw,1.22rem);color:var(--muted);max-width:34rem}
.lp-ctas{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:22px}.lp-ctas .btn{min-height:50px;padding:12px 22px;font-size:1.02rem}
.lp-points{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:.92rem;color:var(--muted)}
.lp-points li::before{content:"✓";color:var(--green);font-weight:800;margin-right:8px}
.lp-art{position:relative;padding:18px}
.lp-window{border:1px solid #c7d4e2;border-radius:16px;background:#fff;box-shadow:0 24px 60px #15243a1f;overflow:hidden}
.lp-bar{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#eef3f8;border-bottom:1px solid var(--line)}
.lp-bar i{width:9px;height:9px;border-radius:50%;background:#c3cfdc}.lp-bar span{margin-left:8px;font-size:.74rem;color:#4a5d74;background:#fff;border-radius:999px;padding:2px 10px}
.lp-site{padding:22px;display:grid;gap:12px;background:linear-gradient(160deg,#e6f1ec,#f6faf8)}
.lp-site strong{font:700 1.5rem/1.1 Georgia,serif;color:#1f4c3e}.lp-site p{margin:0;color:#3d6658;font-size:.9rem}
.lp-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.lp-tiles span{background:#fff;border:1px solid #d3e4dc;border-radius:9px;padding:9px;font-size:.74rem;color:#2c5a4b;font-weight:650}
.lp-chip{position:absolute;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px 12px;font-size:.78rem;font-weight:700;box-shadow:var(--shadow)}
.lp-chip b{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;font-size:.7rem}
.lp-chip-gh{left:-10px;bottom:-4px}.lp-chip-gh b{background:#edf1f5;color:#202c3a}
.lp-chip-cf{right:-6px;top:20%}.lp-chip-cf b{background:var(--orange-soft);color:var(--orange)}
.lp-chip-ok{right:-6px;bottom:-14px}.lp-chip-ok b{background:var(--green-soft);color:var(--green)}
.lp-own{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;list-style:none;margin:0;padding:0}
.lp-own li{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;display:grid;gap:4px}
.lp-own strong{font-size:1.05rem}.lp-own span{color:var(--muted);font-size:.92rem}
.lp-sec-head{display:grid;gap:8px;margin-bottom:18px;max-width:44rem}.lp-sec-head h2{margin:0;font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.045em;line-height:1.1}.lp-sec-head p{margin:0;color:var(--muted)}
.lp-faq details{background:#fff;padding:14px 18px}.lp-faq-a{margin-top:8px;color:var(--muted)}.lp-faq-a p{margin:0 0 8px}
.lp-start{background:#fff;border:1px solid var(--line);border-radius:22px;padding:clamp(18px,4vw,40px);box-shadow:var(--shadow);scroll-margin-top:80px}
.lp-start .provider-guides{margin-top:0}
.lp-final{text-align:center;display:grid;justify-items:center;gap:12px;padding:clamp(26px,5vw,48px);border-radius:22px;background:#18334f;color:#fff}
.lp-final h2{margin:0;font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:-.04em}.lp-final p{margin:0;color:#d0e3fa}
.lp-final .btn{background:#fff;color:#18334f;border-color:#fff}.lp-final .btn:hover{background:#e6eefb;color:#18334f}
#explore,#faq{scroll-margin-top:80px}
.lp .lo-marketing{max-width:none;padding:0;background:transparent;border-radius:0}
.lp .lo-marketing .lo-hero h2{font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.045em;max-width:44rem}
@media(max-width:900px){.lp-hero{grid-template-columns:1fr}.lp-art{max-width:520px}}
@media(max-width:700px){.lp-own{grid-template-columns:1fr}.lp-chip{position:static;display:inline-flex;margin-top:8px}.lp-art{padding:0;display:grid;gap:0}.lp-chips{display:flex;flex-wrap:wrap;gap:8px}}
`;

/** What the verified ZIP import accepts today (onboarding/website-zip.mjs). Shared by the landing page and the upload form. */
export const zipCompatibilityHtml =
  '<div class="lp-compat"><div class="ok"><strong>Works today</strong><ul><li>A finished, built website with <code>index.html</code> at the top or in one folder</li><li>HTML, CSS, JavaScript, images and fonts</li><li>Up to 6 MB zipped, 128 files</li><li>Publishes after checks. Launch &amp; Own editing for uploaded sites is not available yet</li></ul></div>'+
  '<div class="limited"><strong>Compiled sites</strong><ul><li>Compiled or minified sites (for example a Vite <code>dist</code> folder) can publish exactly as uploaded once they pass the same checks</li><li>You can edit them with your own AI coding tool. Launch &amp; Own editing for uploaded sites is not available yet</li></ul></div>'+
  '<div class="no"><strong>Not supported yet</strong><ul><li>Unbuilt project source (<code>package.json</code>, React or Vite source before building)</li><li>Sites that need a server, database or build step</li></ul></div></div>';

// Name lives on the radio; the visible spans are hidden from assistive tech so screen readers announce each tab once.
const tab=(id,label,hint,checked)=>'<label class="lo-tab"><input class="lo-radio" type="radio" name="lo-explore" id="lo-tab-'+id+'" value="'+id+'" aria-label="'+label+': '+hint+'"'+(checked?' checked':'')+'><span class="lo-tab-label" aria-hidden="true">'+label+'</span><span class="lo-tab-hint" aria-hidden="true">'+hint+'</span></label>';

// Honest maintenance paths (#165, #43/#55): only the independent tool path is available today.
const maintainPaths = '<div class="lo-paths" aria-label="Ways to make changes">'+
  '<article class="lo-path"><span class="lo-path-badge">Available with your own tools</span><h3>Your own AI coding tool</h3><p>Codex (ChatGPT), Claude Code or another GitHub coding tool with write access can propose changes in your repository. Read-only ChatGPT GitHub access cannot push changes, and setup and permissions depend on the tool you choose.</p><p>Ask it for a separate branch and a pull request you review. Do not let it write straight to your production branch.</p></article>'+
  '<article class="lo-path"><span class="lo-path-badge plan">Planned · not released</span><h3>Your own website assistant</h3><p>We are designing a private assistant that would run in your own Cloudflare account, use your own Workers AI allowance, and prepare changes for you to preview and approve. It would never merge for you.</p><p>Not available yet, and no release date is promised.</p></article></div>';

/** Tabbed explorer built from #164's components (consumed unchanged). */
export function exploreMarkup({zipEnabled=false}={}){
  const pipeline=marketingPipelineMarkup({zipEnabled});
  const journey=aiUpdateJourneyMarkup();
  const from=pipeline.indexOf('<ol class="lo-flow"'), to=pipeline.indexOf(journey), foot=pipeline.indexOf('<div class="lo-footer">');
  // shortcut: slices #164's markup by stable markers; ask #164 for a launchFlowMarkup() export if this ever breaks (test guards it).
  if(from<0||to<from||foot<to)throw Error('marketing-pipeline markup changed; update exploreMarkup');
  const lede=zipEnabled
    ?'Bring a finished website you built anywhere, or create a simple one here. We guide the connections, show you a private preview of exactly what will be published, and launch only when you approve.'
    :'Create a website and publish it using accounts that belong to you. We guide the connections, show you a private preview of exactly what will be published, and launch only when you approve.';
  return '<div class="lo-marketing" id="explore" aria-labelledby="lo-explore-title"><div class="lo-hero"><p class="lo-kicker">How it works</p><h2 id="lo-explore-title">Launch today. Improve any time. Grow when you are ready.</h2></div>'+
    '<fieldset class="lo-tabs"><legend class="lo-sr">Choose what to explore</legend>'+
    tab('launch','Launch','Get your business online',true)+tab('maintain','Maintain','Make changes. Just ask.')+tab('grow','Grow','Grow beyond a website')+'</fieldset>'+
    '<section class="lo-panel lo-p-launch" aria-labelledby="lo-launch-title"><div class="lo-panel-head"><h3 id="lo-launch-title">Get your business online.</h3><p class="lo-lede">'+lede+'</p><div class="lo-trust"><span>No code needed for a simple site</span><span>Nothing publishes without your approval</span><span>Your files stay yours</span></div></div>'+
    pipeline.slice(from,to)+
    (zipEnabled?'<details><summary>What kind of website can I bring?</summary>'+zipCompatibilityHtml+'</details>':'')+'</section>'+
    '<section class="lo-panel lo-p-maintain" aria-label="Maintain: make changes">'+journey+maintainPaths+'</section>'+
    '<section class="lo-panel lo-p-grow" aria-label="Grow beyond a website">'+serviceExplorerMarkup()+'</section>'+
    pipeline.slice(foot,pipeline.lastIndexOf('</div>'))+'</div>';
}

const faq = zipEnabled => [
  ...(zipEnabled?[['What kind of website can I bring?','Finished, built websites work best: an <code>index.html</code> with its HTML, CSS, JavaScript, images and fonts, zipped. Unbuilt project source, such as a React or Vite project before building, is not supported yet.',zipCompatibilityHtml]]:[]),
  ['What will I connect, and what can Launch &amp; Own do?','You sign in to GitHub and install the Launch &amp; Own GitHub app so it can create a private repository for your website files. You connect Cloudflare and pick the account that hosts the site. Cloudflare also needs its own Workers &amp; Pages GitHub app with access to that repository. Each provider shows you the permissions before you agree. No repository or hosting project is created until you approve the exact preview.'],
  ['What does it cost?','GitHub and Cloudflare offer free plans that suit many simple sites, subject to their plan and usage limits. Launch &amp; Own does not sell you a hosting subscription. A custom domain or extra services may cost money from the provider you choose.'],
  ['Can I use my own domain?','Your site launches on a free <code>pages.dev</code> address. After launch you can save a custom domain request from your toolkit. Saving it does not change DNS. Each step needs your separate review and approval.'],
  ['Can AI update my website?','Today, you can use your own AI coding tool with write access to your repository, such as Codex or Claude Code, to propose changes as pull requests you review and merge. A private assistant running in your own Cloudflare account is planned and has not been released; it would never approve or merge for you. With your own tool, ask for pull requests and keep merging in your own hands.'],
  ['What happens if I stop using Launch &amp; Own?','Your files stay in your GitHub repository and your site stays in your Cloudflare account. You can disconnect at any time and remove app access in each provider\'s settings.']
];

/** setupHtml: trusted server-rendered setup (notices + existing provider connection cards). */
export function landingMarkup({zipEnabled=false,setupHtml=''}={}) {
  const zip=zipEnabled===true;
  const hero=zip
    ?'<p class="lp-kicker">Build anywhere. Own everything.</p><h1 id="lp-title">Your website.<br>Your rules.</h1>'+
      '<p class="lp-lede">Built your site with ChatGPT, Claude or another tool? Bring the finished files as a ZIP. We check them, show you a private preview and publish to GitHub and Cloudflare accounts you own.</p>'+
      '<div class="lp-ctas"><a class="btn" href="#get-started">Bring my website</a><a class="btn btn-secondary" href="#get-started">No site yet? Create one</a></div>'+
      '<ul class="lp-points"><li>Finished static websites with an index.html</li><li>Your own GitHub and Cloudflare accounts, free plans within provider limits</li><li>Nothing publishes without your approval</li></ul>'
    :'<p class="lp-kicker">Describe it. Launch it. Own it.</p><h1 id="lp-title">Your website.<br>Your rules.</h1>'+
      '<p class="lp-lede">Launch a clean, simple website in accounts you own. See a private preview of exactly what will be published and approve it before anything goes live. Keep your files and hosting if you ever leave.</p>'+
      '<div class="lp-ctas"><a class="btn" href="#get-started">Launch my website</a><a class="btn btn-secondary" href="#explore">See how it works</a></div>'+
      '<ul class="lp-points"><li>Your own GitHub and Cloudflare accounts</li><li>Free plans for many simple sites, within provider limits</li><li>Nothing publishes without your approval</li></ul>';
  return '<div class="lp">'+
    '<section class="lp-hero" aria-labelledby="lp-title"><div>'+hero+'</div>'+
    '<div class="lp-art" aria-hidden="true"><div class="lp-window"><div class="lp-bar"><i></i><i></i><i></i><span>your-business.pages.dev</span></div>'+
    '<div class="lp-site"><strong>Green Willow Studio</strong><p>Portraits, events and editing in the heart of town.</p><div class="lp-tiles"><span>Portraits</span><span>Events</span><span>Editing</span></div></div></div>'+
    '<div class="lp-chips"><span class="lp-chip lp-chip-gh"><b>GH</b>Your files · GitHub</span><span class="lp-chip lp-chip-cf"><b>CF</b>Your hosting · Cloudflare</span><span class="lp-chip lp-chip-ok"><b>✓</b>Approved by you</span></div></div></section>'+
    exploreMarkup({zipEnabled:zip})+
    '<section aria-labelledby="lp-own-title"><div class="lp-sec-head"><h2 id="lp-own-title">You stay in control</h2></div><ul class="lp-own">'+
    '<li><strong>Your accounts</strong><span>Files in your GitHub. Hosting in your Cloudflare.</span></li>'+
    '<li><strong>Low-cost options</strong><span>Free provider plans for many simple sites. Extras are optional.</span></li>'+
    '<li><strong>Your approval</strong><span>You see the exact preview and decide what goes live.</span></li></ul></section>'+
    '<section id="faq" class="lp-faq" aria-labelledby="lp-faq-title"><div class="lp-sec-head"><h2 id="lp-faq-title">Questions, answered</h2></div>'+
    faq(zip).map(([q,a,extra=''])=>'<details><summary>'+q+'</summary><div class="lp-faq-a"><p>'+a+'</p>'+extra+'</div></details>').join('')+'</section>'+
    '<section id="get-started" class="lp-start" aria-labelledby="lp-start-title"><div class="lp-sec-head"><p class="lp-kicker">Get started</p><h2 id="lp-start-title">Start your launch</h2><p>'+
    (zip?'Upload a website you already built, or create a simple one here.':'Create a simple website here.')+
    ' Connect GitHub first, then Cloudflare. Returning owners sign in the same way to reach their toolkit and launch history.</p></div>'+setupHtml+'</section>'+
    '<section class="lp-final" aria-labelledby="lp-final-title"><h2 id="lp-final-title">Ready when you are.</h2><p>Describe it. Launch it. Own it.</p><a class="btn" href="#get-started">'+(zip?'Bring my website':'Launch my website')+'</a></section>'+
    '</div>';
}
