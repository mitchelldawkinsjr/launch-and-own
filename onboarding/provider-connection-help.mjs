/**
 * Plain-language clickable icons for the onboarding account connection step.
 * Native details/summary works with keyboard and without JS/external scripts.
 * Only verified server state determines which OAuth action is presented.
 */
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
}[char]));
// Inline icons from Simple Icons (GitHub, Cloudflare); no external requests.
const iconPaths = Object.freeze({
  github: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  cloudflare: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727'
});
function icon(name) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="' + iconPaths[name] + '"/></svg>';
}
export const providerHelpCss = [
  '.provider-guides{margin-top:1.25rem}',
  '.provider-guides h2{font-size:1.2rem;margin:0 0 .35rem}',
  '.provider-intro{color:var(--muted);margin:.25rem 0 1rem}',
  '.provider-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:1rem}',
  '.provider-tile{border:1px solid #dce4ef;border-radius:14px;padding:1rem;background:#fff;min-width:0}',
  '.provider-tile details{margin:0;border:0;padding:0;background:transparent}',
  '.provider-tile summary{display:flex;align-items:center;gap:.75rem;list-style:none;cursor:pointer;min-height:52px;border-radius:7px}',
  '.provider-tile summary::-webkit-details-marker{display:none}',
  '.provider-tile summary:focus-visible{outline:3px solid var(--blue);outline-offset:3px}',
  '.provider-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:48px;height:48px;border-radius:12px}',
  '.provider-icon-gh{background:#eef2f7;color:#202936}',
  '.provider-icon-cf{background:#fff1e5;color:#f38020}',
  '.provider-name{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.35}',
  '.provider-name strong{font-size:1.1rem}',
  '.provider-name small{color:var(--muted);font-size:.83rem}',
  '.provider-why{font-size:.8rem;color:var(--blue);font-weight:650;white-space:nowrap}',
  '.provider-tile details[open] .provider-why{color:var(--muted)}',
  '.provider-tile ul{margin:.8rem 0 .6rem;padding-left:1.25rem}',
  '.provider-tile li{margin-bottom:.45rem}',
  '.provider-status{font-size:.9rem;color:#344963;margin:.8rem 0 .55rem}',
  '.provider-tile a.provider-connect{display:inline-block;padding:.55rem .85rem;border-radius:8px;background:var(--blue);color:white;text-decoration:none;font-weight:650}',
  '.provider-tile a.provider-connect:focus-visible{outline:3px solid var(--blue);outline-offset:3px}',
  '.provider-future{font-size:.9rem;color:var(--muted)}'
].join('');
function providerCard({key,name,summary,bullets,status,href,action,state}) {
  const items=bullets.map(text=>'<li>'+escape(text)+'</li>').join('');
  const callToAction=state==='next'?'<a class="provider-connect" href="'+href+'">'+action+'</a>':'';
  return '<div class="provider-tile provider-'+key+'"><details><summary aria-label="Learn what '+name+' is and why you need it">'+
    '<span class="provider-icon provider-icon-'+(key==='github'?'gh':'cf')+'">'+icon(key)+'</span>'+
    '<span class="provider-name"><strong>'+name+'</strong><small>'+summary+'</small></span>'+
    '<span class="provider-why" aria-hidden="true">Why?</span></summary><ul>'+items+'</ul></details>'+
    '<p class="provider-status">'+escape(status)+'</p>'+callToAction+'</div>';
}
/** Reusable with the plain Worker layout and the open Stitch redesign. */
export function providerConnectionCards({
  githubStatus='next',cloudflareStatus='later',githubLogin='',
  githubAppInstalled=false,cloudflareAccountSelected=false
}={}) {
  const allowed=['next','later','connected'];
  if(!allowed.includes(githubStatus)||!allowed.includes(cloudflareStatus))
    throw new TypeError('Unknown provider connection state');
  const ghState=githubStatus==='connected'
    ?(githubAppInstalled?'GitHub connected':'GitHub signed in — finish app setup below')+
      (githubLogin?' as @'+githubLogin:'')
    :'Step 1 — Connect your GitHub account';
  const cfState=cloudflareStatus==='connected'
    ?(cloudflareAccountSelected?'Cloudflare connected — hosting account selected':
      'Cloudflare connected — choose your hosting account')
    :cloudflareStatus==='next'
      ?'Step 2 — Connect your Cloudflare account'
      :'Next: finish the GitHub step first';
  const github=providerCard({
    key:'github',name:'GitHub',summary:'Keeps your website files',
    bullets:[
      'Keeps a private copy of your website files in your own account.',
      'Saves a history of changes so you can review updates.',
      'Your website files remain yours even if you stop using Launch & Own.'
    ],status:ghState,href:'/connect/github',action:'Connect GitHub',state:githubStatus
  });
  const cloudflare=providerCard({
    key:'cloudflare',name:'Cloudflare',summary:'Puts your website online',
    bullets:[
      'Publishes the website you approve so people can visit it.',
      'Helps your website load quickly and provides secure HTTPS.',
      'You choose the Cloudflare account that hosts your site.'
    ],status:cfState,href:'/connect/cloudflare',action:'Connect Cloudflare',state:cloudflareStatus
  });
  return '<section class="provider-guides" aria-labelledby="provider-guides-heading">'+
    '<h2 id="provider-guides-heading">Why do I need these two accounts?</h2>'+
    '<p class="provider-intro">GitHub keeps your files. Cloudflare shows your site to visitors. Click either icon to learn more.</p>'+
    '<div class="provider-grid">'+github+cloudflare+'</div>'+
    '<p class="provider-future">Both offer free options for simple sites within plan limits. A custom domain name may cost extra.</p>'+
    '</section>';
}
