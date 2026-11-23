# Domain approval review (#88)

[`pipeline/domain-approval-review.mjs`](../pipeline/domain-approval-review.mjs) builds the package Domain reviews before any custom domain, Email Routing, or redirect change.

`domainConsent: true` means the site owner asked for a review. It does **not** approve a DNS or MX write. Every result keeps `dnsWriteAuthorized`, `mxWriteAuthorized`, and `nameserverChangeAuthorized` false.

| Capability | Until Domain approves a specific write |
|---|---|
| Custom domain / TLS | `manual_setup`. Domain registration is not included. Universal SSL covers the apex and one label. |
| Email Routing | `manual_setup` only with an existing mailbox **off** the site hostname. No sending mailbox. No MX/SPF/DKIM change. |
| Redirects | Same-host path rules only. External targets are rejected. |

Domain approval for a later write has to name the account, hostname, and exact records. This module does not call Cloudflare.
