// Read-only inbox for a site's contact form. Messages are read from the owner's own customer D1 with
// the owner's Cloudflare grant, shown once, and never stored or logged by Launch & Own.
import {isCustomerFormsDatabaseId} from '../pipeline/forms-provider-plan.mjs';

export const MESSAGES_SQL = 'SELECT id, fields_json, reply_email, created_at FROM contact_submissions ' +
  'ORDER BY created_at DESC LIMIT 50';
const ACCOUNT = /^[a-f0-9]{32}$/;

export class FormMessagesUnavailable extends Error {
  constructor(code) { super('Messages unavailable (' + code + ')'); this.code = code; }
}

export async function readFormMessages({accountId, databaseId, cloudflareToken, fetchFn = fetch}) {
  if (!ACCOUNT.test(accountId || '') || !isCustomerFormsDatabaseId(databaseId) || typeof cloudflareToken !== 'string' || !cloudflareToken)
    throw new FormMessagesUnavailable('form_service_not_ready');
  let response;
  try {
    response = await fetchFn('https://api.cloudflare.com/client/v4/accounts/' + accountId + '/d1/database/' + databaseId + '/query', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: {authorization: 'Bearer ' + cloudflareToken, accept: 'application/json', 'content-type': 'application/json'},
      body: JSON.stringify({sql: MESSAGES_SQL})
    });
  } catch { throw new FormMessagesUnavailable('provider_temporarily_unavailable'); }
  if (response.status === 401) throw new FormMessagesUnavailable('reconnect_required');
  if (response.status === 403) throw new FormMessagesUnavailable('permission_required');
  if (!response.ok) throw new FormMessagesUnavailable('provider_temporarily_unavailable');
  const data = await response.json().catch(() => null);
  const rows = data?.success === true && Array.isArray(data.result) ? data.result[0]?.results : null;
  if (!Array.isArray(rows)) throw new FormMessagesUnavailable('provider_temporarily_unavailable');
  return rows.slice(0, 50).flatMap(row => {
    let fields;
    try { fields = JSON.parse(row.fields_json); } catch { return []; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Number.isSafeInteger(row.created_at)) return [];
    const entries = Object.entries(fields).filter(([key, value]) => typeof key === 'string' && typeof value === 'string').slice(0, 20);
    return [{createdAt: row.created_at, replyEmail: typeof row.reply_email === 'string' ? row.reply_email : null, entries}];
  });
}

const COPY = {
  form_service_not_ready: 'Set up the contact form from Optional features first.',
  reconnect_required: 'Reconnect Cloudflare to read your messages.',
  permission_required: 'Your Cloudflare connection does not allow reading the form database yet. Reconnect Cloudflare after forms are switched on.',
  provider_temporarily_unavailable: 'Cloudflare did not answer just now. Try again in a minute.'
};
export const messagesProblem = code => COPY[code] || COPY.provider_temporarily_unavailable;

export function renderFormMessages(messages, {escape, databaseName}) {
  const list = messages.length
    ? '<ol class="lo-messages">' + messages.map(message => {
      const when = new Date(message.createdAt * 1000).toISOString();
      const reply = message.replyEmail && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(message.replyEmail)
        ? ' · <a href="mailto:' + escape(message.replyEmail) + '">Reply</a>' : '';
      return '<li><p><time datetime="' + escape(when) + '">' + escape(when.slice(0, 16).replace('T', ' ')) + ' UTC</time>' + reply + '</p><dl>' +
        message.entries.map(([key, value]) => '<dt>' + escape(key) + '</dt><dd>' + escape(value) + '</dd>').join('') + '</dl></li>';
    }).join('') + '</ol>'
    : '<p>No messages yet. New messages show up here as soon as someone sends your form.</p>';
  return '<p>Your newest 50 messages, read directly from your own Cloudflare database <code>' + escape(databaseName) +
    '</code>. Launch &amp; Own does not keep a copy.</p>' + list;
}
