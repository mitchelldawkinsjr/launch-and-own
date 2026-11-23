# Post-launch options approvals (#88)

After a site is live, [`/site-options`](../onboarding/post-launch-options.mjs) lets the verified owner store separate requests for a custom domain, email forwarding, and a contact-form plan.

Each kind has its own prepare → confirm → store path. The confirm page shows the SHA-256 digest. The server recomputes that digest and writes `onboarding_option_approvals` only when it matches. Status is always `stored`.

These rows do **not** attach a hostname, write MX/SPF/DKIM, create Turnstile, D1, or a form Worker, or call Cloudflare/GitHub. A later agent consumes a matching row before any provider write. Domain still authorizes DNS and mail changes. Forms still need the #89 cost/privacy gate.

Migration `0005_option_approvals.sql` is additive. Do not apply it to the hosted D1 from this PR alone; coordinate with Domain before any remote apply or Worker deploy that depends on the table.
