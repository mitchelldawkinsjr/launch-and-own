export const pagesAccessPath = '/cloudflare-pages-access';

const settings = 'https://dash.cloudflare.com/profile/api-tokens';
export const pagesAccessLink = '<a href="' + pagesAccessPath + '">Connect Cloudflare Pages access</a>';
export const isPagesAccessError = value => typeof value === 'string' &&
  /^cloudflare_pages_(?:http_(?:401|403)(?:_|$)|access_changed$|create_access_required$|dashboard_setup_required$)/.test(value);

export function renderPagesAccess(current, access, {view, escape, button}, {message = '', status = 200} = {}) {
  const active = access ? '<p class="pill">' +
    (access.mode === 'edit' ? 'Connected for approved launches' : 'Connected for verification') + '</p>' +
    button(pagesAccessPath + '/remove', 'Remove Pages access from this session', current.csrf,
      '<input type="hidden" name="accessId" value="' + escape(access.access_id) + '">') : '';
  const form = button(pagesAccessPath, access ? 'Replace Pages access' : 'Connect Pages access', current.csrf,
    '<label for="pages-mode">Allow Launch &amp; Own to</label>' +
    '<select id="pages-mode" name="mode"><option value="read">Verify a project I created · Pages Read</option>' +
    '<option value="edit">Create and verify an approved launch · Pages Edit</option></select>' +
    '<label for="pages-token">Cloudflare Pages API token</label>' +
    '<input id="pages-token" name="token" type="password" minlength="20" maxlength="512" autocomplete="off" required>');
  return view('Cloudflare Pages access',
    (message ? '<p role="alert">' + escape(message) + '</p>' : '') +
    '<p>Use this connection if Cloudflare sign-in succeeds and Pages access is denied.</p>' +
    '<p>In <a href="' + settings + '" rel="noreferrer">Cloudflare API Tokens</a>, create a short-lived token for the selected account ' +
    '<code>' + escape(current.cloudflare_account_id) + '</code>. Choose <strong>Account → Cloudflare Pages → Read</strong> ' +
    'to verify a project you created, or <strong>Account → Cloudflare Pages → Edit</strong> for an approved launch.</p>' +
    '<p>Launch &amp; Own encrypts the token for this browser session and uses it for Pages on the selected account. ' +
    'Sign out or remove the connection to delete the stored token. You can revoke the token in Cloudflare.</p>' +
    active + form + '<p><a href="/history">Your launches</a> · <a href="/toolkit">Your website toolkit</a> · <a href="/">Back to setup</a></p>',
    status);
}
