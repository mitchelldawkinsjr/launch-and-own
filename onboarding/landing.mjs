/** Signed-out landing: marketing first, real setup (existing provider cards) at #get-started. Presentation only. */
import {marketingPipelineCss,marketingPipelineMarkup} from './marketing-pipeline.mjs';

export const landingCss = marketingPipelineCss + `
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
.lp-chip-ok{right:-6px;bottom:30%}.lp-chip-ok b{background:var(--green-soft);color:var(--green)}
.lp-own{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;list-style:none;margin:0;padding:0}
.lp-own li{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;display:grid;gap:4px}
.lp-own strong{font-size:1.05rem}.lp-own span{color:var(--muted);font-size:.92rem}
.lp-sec-head{display:grid;gap:8px;margin-bottom:18px;max-width:44rem}.lp-sec-head h2{margin:0;font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.045em;line-height:1.1}.lp-sec-head p{margin:0;color:var(--muted)}
.lp-faq details{background:#fff;padding:14px 18px}.lp-faq p{margin:8px 0 0;color:var(--muted)}
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

const faq = [
  ['What will I connect, and what can Launch &amp; Own do?','You sign in to GitHub and install the Launch &amp; Own GitHub app so it can create a private repository for your website files. You connect Cloudflare and pick the account that hosts the site. Cloudflare also needs its own Workers &amp; Pages GitHub app with access to that repository. Each provider shows you the permissions before you agree, and nothing is created until you approve the exact preview.'],
  ['What does it cost?','GitHub and Cloudflare offer free plans that suit many simple sites, subject to their plan and usage limits. Launch &amp; Own does not sell you a hosting subscription. A custom domain or extra services may cost money from the provider you choose.'],
  ['Can I use my own domain?','Your site launches on a free <code>pages.dev</code> address. After launch you can save a custom domain request from your toolkit. Saving it does not change DNS. Each step needs your separate review and approval.'],
  ['Can AI update my website?','You can use your own AI coding tool with write access to your repository, such as Codex or Claude Code, to propose changes as pull requests you review and merge. A guided Launch &amp; Own update path is planned and has not been released. AI never approves or merges on your behalf.'],
  ['What happens if I stop using Launch &amp; Own?','Your files stay in your GitHub repository and your site stays in your Cloudflare account. You can disconnect at any time and remove app access in each provider\'s settings.']
];

/** setupHtml: trusted server-rendered setup (notices + existing provider connection cards). */
export function landingMarkup({zipEnabled=false,setupHtml=''}={}) {
  return '<div class="lp">'+
    '<section class="lp-hero" aria-labelledby="lp-title"><div><p class="lp-kicker">Describe it. Launch it. Own it.</p>'+
    '<h1 id="lp-title">Your website.<br>Your rules.</h1>'+
    '<p class="lp-lede">Launch a professional website in accounts you own. Preview every page and approve it before anything goes live. Keep your files and hosting if you ever leave.</p>'+
    '<div class="lp-ctas"><a class="btn" href="#get-started">Launch my website</a><a class="btn btn-secondary" href="#explore">See how it works</a></div>'+
    '<ul class="lp-points"><li>Your own GitHub and Cloudflare accounts</li><li>Free plans for many simple sites, within provider limits</li><li>Nothing publishes without your approval</li></ul></div>'+
    '<div class="lp-art" aria-hidden="true"><div class="lp-window"><div class="lp-bar"><i></i><i></i><i></i><span>your-business.pages.dev</span></div>'+
    '<div class="lp-site"><strong>Green Willow Studio</strong><p>Portraits, events and editing in the heart of town.</p><div class="lp-tiles"><span>Portraits</span><span>Events</span><span>Editing</span></div></div></div>'+
    '<div class="lp-chips"><span class="lp-chip lp-chip-gh"><b>GH</b>Your files · GitHub</span><span class="lp-chip lp-chip-cf"><b>CF</b>Your hosting · Cloudflare</span><span class="lp-chip lp-chip-ok"><b>✓</b>Approved by you</span></div></div></section>'+
    marketingPipelineMarkup({zipEnabled})+
    '<section aria-labelledby="lp-own-title"><div class="lp-sec-head"><h2 id="lp-own-title">You stay in control</h2></div><ul class="lp-own">'+
    '<li><strong>Your accounts</strong><span>Files in your GitHub. Hosting in your Cloudflare.</span></li>'+
    '<li><strong>Low-cost options</strong><span>Free provider plans for many simple sites. Extras are optional.</span></li>'+
    '<li><strong>Your approval</strong><span>You see the exact preview and decide what goes live.</span></li></ul></section>'+
    '<section id="faq" class="lp-faq" aria-labelledby="lp-faq-title"><div class="lp-sec-head"><h2 id="lp-faq-title">Questions, answered</h2></div>'+
    faq.map(([q,a])=>'<details><summary>'+q+'</summary><p>'+a+'</p></details>').join('')+'</section>'+
    '<section id="get-started" class="lp-start" aria-labelledby="lp-start-title"><div class="lp-sec-head"><p class="lp-kicker">Get started</p><h2 id="lp-start-title">Start your launch</h2><p>'+
    (zipEnabled?'Create a simple site here, or upload one you already built.':'Create a simple website here.')+
    ' Connect GitHub first, then Cloudflare. Returning owners sign in the same way to reach their toolkit and launch history.</p></div>'+setupHtml+'</section>'+
    '<section class="lp-final" aria-labelledby="lp-final-title"><h2 id="lp-final-title">Ready when you are.</h2><p>Describe it. Launch it. Own it.</p><a class="btn" href="#get-started">Launch my website</a></section>'+
    '</div>';
}
