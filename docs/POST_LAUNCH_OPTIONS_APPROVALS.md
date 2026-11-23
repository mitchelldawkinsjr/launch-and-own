# Post-launch options approvals (#88)

After a site is live, [`/site-options`](../onboarding/post-launch-options.mjs) lets the verified owner store separate requests for a custom domain, email forwarding, and a contact-form plan.

Each kind has its own prepare → confirm → store path. The confirm page shows the SHA-256 digest. The server recomputes that digest and writes `onboarding_option_approvals` only when it matches. Status is always `stored`.

Email rows use `buildEmailRoutingApprovalReview`, which binds the exact external mailbox and fixed `contact@` alias into the digest. The domain planner alone cannot authorize a routing rule.

A stored **domain** row can be applied with **Attach stored domain to Pages**. That uses the owner's Cloudflare token against their verified Pages project. Cloudflare may create DNS in the customer's zone. Platform apex/www/mail DNS are not changed. MX is never written here.

Email rule create and form Worker create stay blocked: Email Routing must already be ready (no MX write from this path), and forms still need a separate #89 cost/privacy approval record.

Migration `0005_option_approvals.sql` is applied on the hosted onboarding D1. Keep platform DNS (`360web.cloud` apex/www/mail) and Brittney untouched.
