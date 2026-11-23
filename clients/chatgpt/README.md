# Launch & Own — ChatGPT connected plugin package (private beta)

**Implementation model: GPT-6 (OpenAI).** This folder is the source-controlled standalone plugin package for the **already deployed** shared MCP endpoint `https://mcp.360web.cloud/mcp`, not a second GitHub/Cloudflare publisher. The existing private `elite-site-pipeline` plugin remains separate and instructions-only; do not silently rename or overwrite it.

## Source layout

- `plugin.json` — portable Agent Plugins 1.0 identity and ChatGPT presentation.
- `mcp.json` — **same shared** Streamable HTTP MCP bridge, OAuth dynamic client registration (DCR) and scope `launch_and_own.bridge`; no secrets.
- `skills/launch-and-own-connected/SKILL.md` — connected tool orchestration, human browser approval, honest verification and ZIP fallback.
- `chatgpt-plugin.test.mjs` — manifest, contract, OAuth, workflow and release-truth regression tests. Run `node --test clients/chatgpt/chatgpt-plugin.test.mjs`.

The release source is `clients/chatgpt/` as a single plugin directory. It may be zipped with that folder as the only enclosing directory. **Exclude README and test file** from the uploaded archive (they are developer support, not plugin runtime components).

## Supported MCP operations

The same 10 operations defined in `integration/mcp-jsonrpc.mjs` are used, including `get_connection_status`, `start_connect_accounts`, `prepare_site`, `get_exact_preview`, `request_explicit_approval`, `get_job_status` and `verify_publication`. No ChatGPT-only bypass or direct provider credentials.

Initial site generation is the **one-page structured generator**. `prepare_site_update` is currently not available on the hosted bridge; custom-built website files/ZIP uploads still go to `https://onboard.360web.cloud` and retain their exact bytes. MCP OAuth authorizes an agent session; the customer must **also** link their GitHub and Cloudflare ownership in the browser before any tenant action.

## Private installation and QA

1. Create a **private** ChatGPT plugin from a ZIP of `plugin.json`, `mcp.json` and the connected skill. The root manifest name is `launch-and-own`.
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
