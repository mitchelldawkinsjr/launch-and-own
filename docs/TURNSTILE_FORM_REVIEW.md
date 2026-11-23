# Turnstile contact-form review (#88)

The isolated planner prepares a private review of a customer-owned contact form. It pairs an exact production hostname with a verified destination reference, site and Git revision. The review step creates no resources and grants no publishing or billing authority.

## Prerequisites

- The backend verifies the current owner session, selected Cloudflare account, Git repository, Pages project and base Git SHA. Hostname and destination records match those immutable values and expire within 15 minutes. The selected hostname is an observed authorized production hostname.
- A delivery record identifies a verified owner inbox or owner-controlled endpoint using an opaque reference. The backend keeps the actual address or URL and credentials private. Keep form submissions under bounded retention and time-based deletion. D1 form storage needs separate cost and privacy review. [#89](https://github.com/mitchelldawkinsjr/launch-and-own/issues/89)
- The plan binds the exact hostname, destination reference, action, rate limit, deletion rules and evidence expiry to the proposal digest. A future executor must recheck every fact and receive separate owner approval before any resource change or delivery.

## Server enforcement and release

A hosted form must call Cloudflare Siteverify from its server with the owner's widget secret. Require a successful result, the exact hostname and action, and one-time validation within the 300-second token lifetime. Reject verification errors, replay, timeouts and quota failures. Enforce the reviewed rate limit and delivery/deletion rules before accepting real submissions. Free currently includes 20 widgets per account, 10 hostnames per widget and unlimited challenges. Worker, email delivery and storage have their own allowances. [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) · [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

This planner has no hosted caller. Rollout requires Domain coordination, exact owner consent and independent acceptance. The static website continues to work independently of contact-form delivery. [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2) · [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21)
