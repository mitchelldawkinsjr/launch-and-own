# Launch & Own — ChatGPT connected plugin package (private beta)

**Implementation model: GPT-6 (OpenAI).** This folder is the source-controlled standalone plugin package for the **already deployed** shared MCP endpoint `https://mcp.360web.cloud/mcp`, not a second GitHub/Cloudflare publisher. The existing private `elite-site-pipeline` plugin remains separate and instructions-only; do not silently rename or overwrite it.

## Browser compatibility: uploaded ZIP is **Desktop only**

**Confirmed 2026-11-23:** the private personal ChatGPT plugin created through Plugin Creator from this remote-MCP ZIP is labeled **Desktop only** on ChatGPT web. This is a **client packaging restriction**, not evidence of a defective HTTPS MCP server. OpenAI explicitly notes that imported plugins containing `mcp.json` / `.mcp.json` can receive this label **even when** the MCP server is remote Streamable HTTP. Renaming the file or adding an `.app.json` pointer does not reliably remove the restriction.

**Current supported web alternative (only where the account/workspace offers it):**

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins) in the browser.
2. Select **Add (+)**, then **Add custom MCP server** (if available).
3. Name it **Launch & Own** and use **https://mcp.360web.cloud/mcp** as the server URL. This is the existing verified remote endpoint; **do not enter** `https://onboard.360web.cloud` as an MCP URL.
4. Select **OAuth**. The bridge supports **Dynamic Client Registration (DCR)**, PKCE S256 and public clients with no static client secret; use DCR if the UI exposes that choice. Scope is `launch_and_own.bridge`. Do **not** paste provider tokens, API keys or OAuth codes into ChatGPT.
5. Review the risk warning and create the private web-compatible connection; install the resulting plugin/app if prompted. Complete the browser OAuth consent and the separate GitHub+Cloudflare owner link via `start_connect_accounts`.
6. In a new ChatGPT conversation, select the installed custom MCP connection and ask for `get_connection_status`. Verify `tools/list` first; then test owner linking and prepare/preview/approval/status on a disposable owner-controlled site. Keep provider mutations gated behind explicit browser approval.

**Plan limit:** current OpenAI documentation lists full custom remote MCP connections for eligible **Business and Enterprise/Edu** workspaces, with workspace permission restrictions. A personal plan may not show **Add custom MCP server** or may restrict write tools. Do not promise that this workaround is available on Plus or that it grants `prepare_site` write access. If the option is absent, use the ChatGPT desktop app for the existing ZIP plugin **or** continue with `https://onboard.360web.cloud` (browser standalone) until a web-supported hosted app/plugin route is shipped.

For a **branded web-installable** version, register the shared remote MCP connection as a supported **ChatGPT app** using the allowed app creation workflow (or ChatGPT Sites hosting if enabled), then reference that verified app from the branded plugin. A naked ZIP `mcp.json` or an invented `.app.json` app ID is not sufficient. This requires separate testing and account/workspace support; do not claim it is completed.

Official references: [ChatGPT plugin compatibility](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt), [imported plugin Desktop only behavior](https://help.openai.com/en/articles/20001504-importing-and-syncing-plugin-marketplaces-from-github), and [custom MCP server setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Custom MCP app description and icon

The ChatGPT **Add custom MCP server** form currently accepts an optional user-entered description; an empty field does **not** imply that the remote MCP connection is broken. Recommended description to paste (or edit in the app's Manage screen if offered):

> Build and launch websites you own using ChatGPT, GitHub, and Cloudflare. Create a website draft, preview the exact result, approve publication securely in your browser, and verify when your site is live.

The bridge source supplies that text in `initialize.serverInfo.description` and advertises the 128×128 PNG at `https://mcp.360web.cloud/launch-and-own-icon.png` on its own origin. The hosted metadata needs the matching Domain-approved bridge deployment. The package includes the same icon in `assets/launch-and-own-icon.png`. The owner can upload this PNG directly in ChatGPT's app settings where supported. Existing custom apps may need an edit or reconnect to pick up the metadata.

**Release note:** this source-only enhancement does not change the ten MCP tools, authentication, tenant permissions or launch approval. Neither an app icon nor a description grants production access.

## Source layout

- `plugin.json` — portable Agent Plugins 1.0 identity and ChatGPT presentation.
- `mcp.json` — **same shared** Streamable HTTP MCP bridge, OAuth dynamic client registration (DCR) and scope `launch_and_own.bridge`; no secrets.
- `skills/launch-and-own-connected/SKILL.md` — connected tool orchestration, human browser approval, honest verification and ZIP fallback.
- `chatgpt-plugin.test.mjs` — manifest, contract, OAuth, workflow and release-truth regression tests. Run `node --test clients/chatgpt/chatgpt-plugin.test.mjs`.

The release source is `clients/chatgpt/` as a single plugin directory, including `assets/`. It may be zipped with that folder as the only enclosing directory. **Exclude README and test file** from the uploaded archive (they are developer support, not plugin runtime components).

## Supported MCP operations

The same 10 operations defined in `integration/mcp-jsonrpc.mjs` are used, including `get_connection_status`, `start_connect_accounts`, `prepare_site`, `get_exact_preview`, `request_explicit_approval`, `get_job_status` and `verify_publication`. No ChatGPT-only bypass or direct provider credentials.

Initial site generation is the **one-page structured generator**. `prepare_site_update` is currently not available on the hosted bridge; custom-built website files/ZIP uploads still go to `https://onboard.360web.cloud` and retain their exact bytes. MCP OAuth authorizes an agent session; the customer must **also** link their GitHub and Cloudflare ownership in the browser before any tenant action.

## Private installation and QA

1. Create a **private** ChatGPT plugin from a ZIP of `plugin.json`, `mcp.json`, `assets/`, and the connected skill. The root manifest name is `launch-and-own`.
2. In ChatGPT, open the private plugin and connect to `https://mcp.360web.cloud/mcp`. Complete the browser OAuth PKCE consent flow for the MCP agent session; never enter API keys in chat. DCR registration uses the server's `/register` endpoint with the client-provided HTTPS callback.
3. With the connected plugin selected, call `get_connection_status`; while unlinked, `start_connect_accounts` returns a trusted `https://onboard.360web.cloud/agent-link?challenge_id=…` browser action. Open it while signed into **both** GitHub and the selected Cloudflare account, review, and confirm the link.
4. Prepare a **fictional** one-page test site with `prepare_site`; obtain the exact preview fingerprint and trusted browser review URL. Do not approve until verifying the site, target private GitHub repository and Cloudflare Pages details in that browser.
5. Separately approve a disposable owner-only test launch. Call `get_job_status` and `verify_publication` using **draft ID as job ID**. A live report needs commit SHA + matching published HTML digest; historical `last_verified` is not a fresh proof.
6. Test a declined review, expired/different account link, stale draft, network failure, reauth/refresh, denied publishing, and no-token-in-chat behavior. Capture redacted results in [Issue #55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55) and #43.

**Current release truth:** the shared MCP backend has an owner-tested Claude Code link/prepare workflow. A private ChatGPT plugin archive or saved plugin **does not** prove a connected ChatGPT client, sign-in, publication or independent customer acceptance. `distribution/release-matrix.json` deliberately keeps `chatgpt_connector.access = not_available` until real ChatGPT QA and orchestration approval. No marketplace/public listing is created by this packaging.

## Safety and maintenance

- Human review and publication approval remain on `onboard.360web.cloud`; a ChatGPT tool cannot approve its own draft.
- No credential paste, implicit authorizations, model-supplied provider identities, account switching, arbitrary HTML execution, browser file uploads through tools, or claims of guaranteed free provider limits.
- Reuse the `integration/` MCP tool schema and provider backend; update this package when the shared contract changes.
- Operator version deployment is serialized through Domain #2. Never re-deploy Workers or change OAuth client scopes during ChatGPT packaging without approved coordination.
