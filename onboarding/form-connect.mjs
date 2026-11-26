// Connects the site's existing contact form to its customer-owned form Worker. Pure: the result is
// shown to the owner as an exact preview and becomes a pull request only after their approval.

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const TURNSTILE_SCRIPT = '<script src="' + TURNSTILE_ORIGIN + '/turnstile/v0/api.js" async defer></script>';
const FORM = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
const WORKER = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/;
const SITEKEY = /^[A-Za-z0-9_-]{8,64}$/;
const DROP_ATTRS = /\s(?:action|method|target|onsubmit|enctype|data-netlify|netlify|data-netlify-honeypot)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;
const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i;

export class FormConnectError extends Error {
  constructor(code) { super('Form connection refused (' + code + ')'); this.code = code; }
}
const refuse = code => { throw new FormConnectError(code); };

function enableSubmit(inner) {
  return inner.replace(/<(button|input)\b([^>]*)>/gi, (tag, name, attrs) => {
    const type = (attrs.match(/\btype\s*=\s*["']?([a-z]+)/i)?.[1] || (name.toLowerCase() === 'button' ? 'submit' : 'text')).toLowerCase();
    if (type !== 'submit') return tag;
    return '<' + name + attrs.replace(/\sdisabled(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '') + '>';
  });
}

// Adds the Turnstile and Worker origins to an existing CSP <meta>. Pages without one are unchanged.
function widenPolicy(html, workerOrigin) {
  const meta = html.match(CSP_META);
  if (!meta) return html;
  const quote = meta[0].match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
  if (!quote) refuse('site_policy_unreadable');
  // Policies written with &#39; entities are decoded first (the entity itself contains a semicolon).
  const encoded = /&#39;|&apos;/i.test(quote[2]);
  const directives = quote[2].replace(/&#39;|&apos;/gi, "'").split(';').map(part => part.trim()).filter(Boolean);
  const add = (name, source) => {
    const at = directives.findIndex(part => part.toLowerCase().split(/\s+/)[0] === name);
    if (at < 0) { directives.push(name + ' ' + source); return; }
    const words = directives[at].split(/\s+/);
    // 'none' cannot be combined with a source, so it is replaced.
    const kept = words.slice(1).filter(word => word.toLowerCase() !== "'none'");
    if (!kept.includes(source)) kept.push(source);
    directives[at] = name + ' ' + kept.join(' ');
  };
  add('script-src', TURNSTILE_ORIGIN);
  add('frame-src', TURNSTILE_ORIGIN);
  add('connect-src', TURNSTILE_ORIGIN);
  add('form-action', workerOrigin);
  const joined = directives.join('; ');
  const content = encoded ? joined.replace(/'/g, '&#39;') : joined;
  if (content.includes(quote[1])) refuse('site_policy_unreadable');
  return html.replace(meta[0], meta[0].replace(quote[0], 'content=' + quote[1] + content + quote[1]));
}

/** Returns the page with form number `formIndex` posting to the Worker, protected by Turnstile. */
export function connectContactForm(html, {formIndex, workerUrl, sitekey}) {
  if (typeof html !== 'string' || !Number.isSafeInteger(formIndex) || formIndex < 0) refuse('form_not_found');
  if (!WORKER.test(workerUrl || '') || !SITEKEY.test(sitekey || '')) refuse('form_service_not_ready');
  if (!/<\/body>/i.test(html)) refuse('page_body_missing');
  const forms = [...html.matchAll(FORM)];
  const target = forms[formIndex];
  if (!target) refuse('form_not_found');
  if (target[2].includes('cf-turnstile')) refuse('form_already_connected');
  const [whole, attrs, inner] = target;
  const opening = '<form' + attrs.replace(DROP_ATTRS, '') + ' action="' + workerUrl + '/submit" method="post">';
  const connected = opening + enableSubmit(inner) +
    '<div class="cf-turnstile" data-sitekey="' + sitekey + '"></div></form>' +
    '<p id="form-sent" class="lo-form-note" role="status">Thanks, your message was sent.</p>' +
    '<p id="form-error" class="lo-form-note" role="alert">Your message was not sent. Check the form and try again.</p>';
  let next = html.slice(0, target.index) + connected + html.slice(target.index + whole.length);
  const style = '<style>.lo-form-note{display:none}.lo-form-note:target{display:block}</style>';
  next = /<\/head>/i.test(next) ? next.replace(/<\/head>/i, style + '</head>') : style + next;
  if (!next.includes(TURNSTILE_SCRIPT)) next = next.replace(/<\/body>(?![\s\S]*<\/body>)/i, TURNSTILE_SCRIPT + '</body>');
  return widenPolicy(next, workerUrl);
}

/** Plain-language list of what the pull request changes, for the review page. */
export function formConnectSummary({path, workerUrl, hasPolicy}) {
  return [
    'Your form on ' + path + ' sends messages to your form service at ' + workerUrl + '.',
    'Spam protection (Cloudflare Turnstile) is added to the form.',
    'The send button is turned on.',
    'Short "sent" and "not sent" messages appear after someone sends the form.',
    ...(hasPolicy ? ['The page\'s security settings allow Turnstile and your form service.'] : [])
  ];
}
