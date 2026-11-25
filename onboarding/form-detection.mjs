// Finds the site's existing contact form so the forms option connects that form, with its own fields,
// instead of adding a second one. Read-only: it only reads the site's HTML.

const decoder = new TextDecoder('utf-8', { fatal: false });
const FORM = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
const FIELD = /<(input|select|textarea)\b([^>]*)>/gi;
const CONTACT_WORDS = /contact|inquir|enquir|booking|book|quote|message|appointment|reach/i;
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search']);
const MAX_FIELDS = 20;

const attr = (attrs, name) => {
  const match = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
};

function destination(action, attrs) {
  if (/\bdata-netlify\b/i.test(attrs)) return 'netlify';
  if (!action || action === '#') return 'none';
  if (/^mailto:/i.test(action)) return 'email_app';
  if (/^https?:\/\//i.test(action)) return 'another_service';
  return 'this_site';
}

/** files: [{path, bytes}] with paths relative to the published folder. Returns the best contact form, or null. */
export function detectContactForm(files) {
  const found = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!/\.html?$/i.test(file?.path || '') || !(file.bytes instanceof Uint8Array)) continue;
    const html = decoder.decode(file.bytes);
    for (const [, attrs, inner] of html.matchAll(FORM)) {
      const fields = [];
      let email = false, longText = false;
      for (const [, tag, fieldAttrs] of inner.matchAll(FIELD)) {
        const type = (attr(fieldAttrs, 'type') || (tag.toLowerCase() === 'input' ? 'text' : tag)).toLowerCase();
        const name = attr(fieldAttrs, 'name');
        if (SKIP_TYPES.has(type) || !name || !/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(name)) continue;
        if (type === 'email' || /e-?mail/i.test(name)) email = true;
        if (tag.toLowerCase() === 'textarea') longText = true;
        if (!fields.includes(name) && fields.length < MAX_FIELDS) fields.push(name);
      }
      if (!fields.length) continue;
      const id = attr(attrs, 'id'), action = attr(attrs, 'action');
      const label = [id, attr(attrs, 'class'), attr(attrs, 'name'), action].filter(Boolean).join(' ');
      const score = (email ? 3 : 0) + (longText ? 2 : 0) + (CONTACT_WORDS.test(label) ? 2 : 0) + (/contact/i.test(file.path) ? 1 : 0);
      if (score < 3) continue; // A search or newsletter box is not the contact form.
      found.push({ path: file.path, id, fields, destination: destination(action, attrs),
        submitDisabled: /<button\b[^>]*\bdisabled\b|<input\b[^>]*type=["']?submit["']?[^>]*\bdisabled\b/i.test(inner), score });
    }
  }
  found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!found.length) return null;
  const { score, ...best } = found[0];
  return { ...best, otherForms: found.length - 1 };
}

const PAGE = path => '/' + path.replace(/(?:^|\/)index\.html?$/i, '').replace(/\.html?$/i, '');

/** Plain-language summary for the optional features page. */
export function contactFormSummary(form, escape) {
  if (!form) return '<p>We did not find a contact form on your site. When forms are set up, we can add a simple one for you to review.</p>';
  const where = escape(PAGE(form.path).replace(/\/$/, '') || '/');
  const name = form.id ? ' (<code>' + escape(form.id) + '</code>)' : '';
  const sends = {
    none: 'It does not send messages anywhere yet.',
    email_app: 'Right now it opens the visitor\'s email app.',
    another_service: 'Right now it sends messages to another service.',
    netlify: 'Right now it is set up for Netlify Forms, which does not run on Cloudflare.',
    this_site: 'Right now it posts to an address on this site.'
  }[form.destination];
  return '<p>We found your contact form on <code>' + where + '</code>' + name + ' with these fields: ' +
    form.fields.map(field => '<code>' + escape(field) + '</code>').join(', ') + '. ' + sends +
    (form.submitDisabled ? ' Its send button is switched off.' : '') +
    ' This is the form we connect, keeping your fields, so you do not get a second form.</p>' +
    (form.otherForms ? '<p>Your site has ' + form.otherForms + ' other form' + (form.otherForms === 1 ? '' : 's') + '. We picked the one that looks most like a contact form.</p>' : '');
}
