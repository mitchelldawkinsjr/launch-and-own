# Launch & Own — example agent scripts

Fictional businesses only. Do not paste real customer content into public trackers.

## 1) Build a new one-page site (usable today)

**Customer:** “Help me make a site for Green Willow Studio, a portrait photographer.”

**Agent should:**

1. Draft accessible copy and generate a **deployable static site directory** containing `index.html` and its referenced assets; preview and check it locally.
2. **Package the generated site as a static ZIP**, preserving the exact HTML/assets. Exclude secrets and development dependencies; verify the limits in `reference.md`. If packaging is unavailable, give the customer the completed static directory and clear local-compression instructions rather than inventing an attachment.
3. Say clearly: *These are prepared website files. Nothing is published yet.*
4. Hand off: open `https://onboard.360web.cloud` → Connect GitHub → **Install** Launch & Own → Connect Cloudflare → **Upload a built website** → upload the ZIP → review the exact private preview and file manifest → **Approve and create website** only if the customer wants resources created. **Do not send this generated HTML to the manual form**; re-entering copy there would replace the site with a different design.
5. Refuse to claim a live URL until the customer reports status `live` (or a future verified tool does).

**Do not:** invent `esp-…pages.dev` URLs, commit SHAs, or “published successfully” messages.

## 2) Launch my existing static ZIP (hosted browser beta)

**Customer:** “I already have a static site ZIP. Publish it.”

**Agent should:**

1. Validate ZIP constraints from `reference.md` (size, `index.html`, no `_worker.js` / PHP / secrets).
2. Explain **Upload a built website** is enabled in the hosted browser beta after owner testing; separate external customer acceptance is still outstanding. If the option is unavailable to the customer, acknowledge the actual UI/account state and suggest local review or manual fallback.
3. Guide the customer to `https://onboard.360web.cloud` → connect their own accounts → upload the ZIP → inspect the manifest → private exact preview → separate approval. The customer, not the chat agent, authorizes publishing.
4. Never ask them to paste ZIP binary contents into chat.

## 3) Update my verified site (mostly future in-product)

**Customer:** “Change the headline on my live Launch & Own site.”

**Agent should:**

1. Ask which GitHub repo / Pages URL they already own (customer-supplied).
2. Today: help draft the new copy; explain updates are owner-controlled (edit repo / future reviewed PR flow). Do **not** claim the in-product maintenance UI (#31) is live.
3. After #31/#43: still require exact preview + separate approval + human merge for PRs — never silent overwrite of `main`.

## 4) Paused / permission denied / reconnect safely

**Customer:** “It says needs_reauthorization / github_http_403.”

**Agent should:**

1. Explain the launch is **paused**, not live.
2. Guide: reconnect GitHub/Cloudflare in the browser; confirm Launch & Own App **install** with repository creation; open **History** → **Review and reapprove** the same launch when available.
3. Warn against starting a second approve that would target a conflicting new site unless the product UI says otherwise.
4. Do not fabricate a fixed error code meaning or claim resources were deleted.
