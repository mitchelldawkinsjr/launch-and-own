// Plain-language beta privacy policy and terms, linked from the OAuth consent screens.
// Keep these statements in sync with what worker.mjs actually stores and does.
export const LEGAL_UPDATED='November 22, 2026';
const CONTACT='https://github.com/mitchelldawkinsjr/launch-and-own/issues';

export const privacyHtml=`<p class="muted">Beta policy · Last updated ${LEGAL_UPDATED}</p>
<p>Launch &amp; Own helps you create a website in <strong>your own</strong> GitHub and Cloudflare accounts. This page explains what the onboarding service at onboard.360web.cloud stores and why.</p>
<section><h2>What we collect</h2><ul>
<li><strong>GitHub identity:</strong> your GitHub user ID and username, to confirm who is signed in.</li>
<li><strong>Provider authorizations:</strong> the access and refresh tokens GitHub and Cloudflare issue when you approve Launch &amp; Own. They are encrypted (AES-GCM) before storage and are never shown to you, other users, or logs.</li>
<li><strong>Cloudflare account choice:</strong> the ID of the Cloudflare account you select.</li>
<li><strong>Website content you enter:</strong> business name, headline, description, services, optional contact email and theme, plus the plan you approve.</li>
<li><strong>Operational logs:</strong> request errors without tokens, cookies, authorization codes or form contents.</li>
</ul></section>
<section><h2>How we use it</h2><p>Only to show your preview, create the private repository and Cloudflare Pages project you approve, open a pull request in that repository for website updates you approve (never merged for you), verify the deployment, and resume an approved launch that was interrupted. We do not sell your data, use it for advertising, or access your accounts for anything you did not approve.</p>
<p><strong>Optional AI drafting:</strong> if you choose it, your business name and description are sent to the configured AI provider to draft website copy. Your contact email is not sent. You can always write the content yourself instead.</p></section>
<section><h2>Cookies</h2><p>Two strictly necessary, secure, HTTP-only cookies: a sign-in cookie (up to 10 minutes) and a session cookie (up to 1 hour). No tracking or advertising cookies.</p></section>
<section><h2>How long we keep it</h2><ul>
<li>Sign-in attempts: deleted after 10 minutes.</li>
<li>Sessions and their encrypted tokens: deleted when they expire (about 1 hour) or when you sign out.</li>
<li>Approved launch history: kept for 30 days, and you can delete entries sooner. Launch history does not contain your tokens.</li>
</ul></section>
<section><h2>Your control</h2><p><strong>Disconnect and sign out</strong> deletes your session and asks GitHub and Cloudflare to revoke Launch &amp; Own's access. You can also revoke access at any time in your GitHub and Cloudflare settings. The repositories and websites created for you stay in your accounts, and you own them.</p></section>
<section><h2>Third parties</h2><p>We rely on GitHub and Cloudflare, which process data under their own privacy policies, and on the AI provider only if you use AI drafting.</p></section>
<section><h2>Contact and changes</h2><p>Questions or requests: <a href="${CONTACT}">open an issue</a>. We will update this page and its date when practices change.</p></section>
<p><a href="/terms">Terms of Service</a> · <a href="/">Back to setup</a></p>`;

export const termsHtml=`<p class="muted">Beta terms · Last updated ${LEGAL_UPDATED}</p>
<section><h2>The service</h2><p>Launch &amp; Own is a free beta that helps you create a website in your own GitHub and Cloudflare accounts. Features may change, pause or stop without notice while it is in beta.</p></section>
<section><h2>Your accounts and content</h2><ul>
<li>You must be authorized to use the GitHub and Cloudflare accounts you connect.</li>
<li>Nothing is created until you review and approve it. You own the repositories, Pages projects and website content created for you.</li>
<li>You are responsible for the content you publish and must not use the service for unlawful, harmful or infringing material.</li>
<li>Your use of GitHub and Cloudflare remains subject to their terms, plans and any charges they apply.</li>
</ul></section>
<section><h2>AI drafts</h2><p>Optional AI-generated copy can be wrong. Review and edit every claim before you publish it.</p></section>
<section><h2>No warranty</h2><p>The service is provided "as is" without warranties of any kind. To the fullest extent permitted by law, the operator is not liable for indirect or consequential losses, lost data or lost profits arising from use of the beta.</p></section>
<section><h2>Ending use</h2><p>You can stop at any time by signing out and revoking access. We may suspend access to protect the service or other users. Ending use does not delete websites or repositories in your own accounts.</p></section>
<section><h2>Contact and changes</h2><p><a href="${CONTACT}">Open an issue</a> with questions. We will update this page and its date if these terms change.</p></section>
<p><a href="/privacy">Privacy Policy</a> · <a href="/">Back to setup</a></p>`;
