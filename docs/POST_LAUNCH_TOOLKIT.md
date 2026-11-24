# Post-launch website toolkit (#87)

Choose **Your website toolkit** after connecting GitHub and selecting a Cloudflare account. The page shows recent launches and finds current managed sites independently of the 30-day launch-history window.

| Surface | Behavior |
| --- | --- |
| `GET /toolkit` | Recent launch records show their stored result and expiry. Current sites come from one page of authenticated Pages discovery and matching private GitHub repositories. |
| Site toolkit | A 15-minute sealed reference binds the selected GitHub user, account, session epoch, repository and Pages project. Each view rechecks ownership and returns `no-store`. |
| Deployment | Compares the canonical production commit and homepage with the current private GitHub revision and file. Both the deployment ID and source are checked again before emitting a verified link. The result includes the check time, commit and homepage digest. |
| Web Analytics | Shows the current configuration evidence and the verified project’s manual Metrics handoff. The owner reviews privacy and beacon impact before a separate production deployment. |
| PR previews | Shows the current branch build setting. Access protection and the exact PR head must be verified separately before any preview link can be shown. |
| Plans and limits | Shows published optional-service allowances and links to the selected account’s Cloudflare dashboard. Live quota headroom requires provider usage evidence. |
| Update and feature requests | A matching, unexpired live launch can link to the existing eligible one-page editor and separately reviewed feature requests. Owners can open their GitHub files after history expires. Sites that lack verified generated-source provenance stay in the GitHub workflow. |

GitHub and Pages read permissions on the selected personal account are required. Analytics and preview checks run on demand and leave the site settings untouched. Inventory checks at most two candidates per page. The deployment view reads at most eight provider API responses and one public homepage. The homepage read carries no provider credentials and stops as soon as its bytes differ from the bounded private file. Private HTML and provider payloads stay on the server.

A site’s deployed homepage can match GitHub today even when the original approval record has expired. That result proves current byte equality at the check time. The approved-update status flow still requires its retained approval digest and exact merge revision. For analytics, beacon activation or other HTML transformations can legitimately make the public bytes differ, which leaves the dashboard verification pending.

## Release and rollback

Local tests cover expired launch history, revoked sessions, replaced repositories/projects, a changed deployment during the check, different public bytes, disabled previews, and the analytics settings handoff. Verify the per-view request budget, a consented real customer and an approved edit before raising the hosted release status. Domain coordinates the Worker rollout through #2. Roll back via the previously approved Worker revision. No new database migration is needed for this dashboard change. [#21 acceptance](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21) · [Domain coordination](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2)
