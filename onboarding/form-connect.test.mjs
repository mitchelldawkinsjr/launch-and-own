import test from 'node:test';
import assert from 'node:assert/strict';
import {connectContactForm, formConnectSummary} from './form-connect.mjs';
import {detectContactForm} from './form-detection.mjs';

const workerUrl = 'https://esp-green-willow-studio-site-form.acct.workers.dev';
const sitekey = '0x4AAAAAAAtestkey';
// Shape of the owner's live Green Willow contact page: a search form first, then the booking form.
const page = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; ' +
  'style-src &#39;unsafe-inline&#39;; script-src https://static.cloudflareinsights.com; form-action &#39;none&#39;"></head><body>' +
  '<form role="search"><input type="search" name="q"></form>' +
  '<form id="booking-form" onsubmit="return false" data-netlify="true"><input name="name"><input name="email" type="email">' +
  '<button class="button form-submit" type="submit" disabled>Send</button><button type="button" disabled>Clear</button></form>' +
  '</body></html>';

test('connects the detected form only, with Turnstile, an enabled send button and a widened page policy', () => {
  const form = detectContactForm([{path: 'contact.html', bytes: new TextEncoder().encode(page)}]);
  assert.equal(form.formIndex, 1);
  const html = connectContactForm(page, {formIndex: form.formIndex, workerUrl, sitekey});
  assert.match(html, /<form role="search"><input type="search" name="q"><\/form>/, 'the search form is untouched');
  assert.match(html, new RegExp('<form id="booking-form" action="' + workerUrl.replace(/\./g, '\\.') + '/submit" method="post">'));
  assert.doesNotMatch(html, /onsubmit|data-netlify/);
  assert.match(html, /<button class="button form-submit" type="submit">Send<\/button>/);
  assert.match(html, /<button type="button" disabled>Clear<\/button>/, 'non-submit buttons keep their state');
  assert.match(html, /<div class="cf-turnstile" data-sitekey="0x4AAAAAAAtestkey"><\/div><\/form>/);
  assert.match(html, /<p id="form-sent" class="lo-form-note" role="status">/);
  assert.match(html, /\.lo-form-note:target\{display:block\}<\/style><\/head>/);
  assert.match(html, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer><\/script><\/body>/);
  const policy = html.match(/content="([^"]+)"/)[1];
  assert.match(policy, /script-src https:\/\/static\.cloudflareinsights\.com https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /form-action https:\/\/esp-green-willow-studio-site-form\.acct\.workers\.dev/);
  assert.doesNotMatch(policy, /form-action &#39;none&#39;/);
  assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /default-src &#39;none&#39;/, 'the rest of the policy is kept');
  assert.throws(() => connectContactForm(html, {formIndex: 1, workerUrl, sitekey}), /form_already_connected/);
});

test('refuses an unready service, a missing form or an untrusted address', () => {
  assert.throws(() => connectContactForm(page, {formIndex: 5, workerUrl, sitekey}), /form_not_found/);
  assert.throws(() => connectContactForm(page, {formIndex: 1, workerUrl: 'https://evil.example', sitekey}), /form_service_not_ready/);
  assert.throws(() => connectContactForm(page, {formIndex: 1, workerUrl, sitekey: '"><script>'}), /form_service_not_ready/);
  assert.throws(() => connectContactForm('<form><input name="email"></form>', {formIndex: 0, workerUrl, sitekey}), /page_body_missing/);
  const plain = '<html><body><form><input name="email" type="email"><textarea name="message"></textarea><button>Send</button></form></body></html>';
  const html = connectContactForm(plain, {formIndex: 0, workerUrl, sitekey});
  assert.match(html, /<style>\.lo-form-note/);
  assert.doesNotMatch(html, /Content-Security-Policy/, 'pages without a policy get none added');
  assert.equal(formConnectSummary({path: '/contact', workerUrl, hasPolicy: false}).length, 4);
});

test('the inline-script check catches a page script but not an external one', () => {
  const inline = /<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S[\s\S]*?<\/script>/i;
  assert.equal(inline.test('<script>document.getElementById("booking-form").onsubmit=e=>e.preventDefault()</script>'), true);
  assert.equal(inline.test('<script src="/app.js"></script>'), false);
  assert.equal(inline.test('<script type="module" src="/a.js"></script><script></script>'), false);
});
