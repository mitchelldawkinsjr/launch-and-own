import test from 'node:test';
import assert from 'node:assert/strict';
import {contactFormSummary, detectContactForm} from './form-detection.mjs';

const file = (path, html) => ({path, bytes: new TextEncoder().encode(html)});
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

test('finds the existing contact form and keeps its own fields', () => {
  const files = [
    file('index.html', '<form role="search"><input type="search" name="q"></form><a href="/contact">Contact</a>'),
    file('contact.html', '<form id="booking-form"><input id="name" name="name"><input name="email" type="email">' +
      '<input name="date" type="date"><select name="type"><option>Portrait</option></select>' +
      '<input type="hidden" name="csrf" value="x"><button type="submit" disabled>Send</button></form>'),
    file('styles.css', 'form{}')
  ];
  const form = detectContactForm(files);
  assert.deepEqual(form, {path: 'contact.html', id: 'booking-form', fields: ['name', 'email', 'date', 'type'],
    destination: 'none', submitDisabled: true, otherForms: 0});
  const html = contactFormSummary(form, escape);
  assert.match(html, /We found your contact form on <code>\/contact<\/code> \(<code>booking-form<\/code>\)/);
  assert.match(html, /<code>name<\/code>, <code>email<\/code>, <code>date<\/code>, <code>type<\/code>/);
  assert.match(html, /send button is switched off/);
  assert.match(html, /so you do not get a second form/);
});

test('prefers the contact form over a newsletter box, and reports where it sends today', () => {
  const files = [
    file('index.html', '<form class="newsletter" action="https://lists.example/sub"><input name="email" type="email"></form>' +
      '<form class="contact" action="mailto:hi@example.com"><input name="email" type="email"><textarea name="message"></textarea></form>')
  ];
  const form = detectContactForm(files);
  assert.equal(form.destination, 'email_app');
  assert.deepEqual(form.fields, ['email', 'message']);
  assert.equal(form.otherForms, 1);
  assert.match(contactFormSummary(form, escape), /on <code>\/<\/code>.*opens the visitor's email app.*1 other form\./s);
});

test('no contact form means we offer to add one; untrusted names are escaped or ignored', () => {
  assert.equal(detectContactForm([file('index.html', '<p>Call us</p>')]), null);
  assert.match(contactFormSummary(null, escape), /did not find a contact form/);
  const form = detectContactForm([file('contact/index.html',
    '<form id="&quot;<x>"><input name="email" type="email"><input name="bad name"><textarea name="msg"></textarea></form>')]);
  assert.deepEqual(form.fields, ['email', 'msg']);
  assert.match(contactFormSummary(form, escape), /on <code>\/contact<\/code>/);
  assert.doesNotMatch(contactFormSummary(form, escape), /<x>/);
});
