# Post-launch website toolkit (#87)

The first toolkit view shows retained launch history for the connected GitHub user and selected Cloudflare account. Successful records include the public address, GitHub revision and time recorded when the launch was verified. The approval fingerprint identifies the approved snapshot. It does not establish a public HTML digest or current deployment.

| Surface | Behavior |
| --- | --- |
| `GET /toolkit` | Shows up to 20 launch records and their expiry dates within the 30-day retention window. Reads display fields in one scoped query and rechecks the authorization epoch before returning them. |
| Current managed sites | Same page soft-loads one #39 provider inventory page (GET-only). Shows GitHub/Pages dashboard links and `main` SHA; does **not** claim public HTML verification or invent live URLs. Failures leave history intact. |
| Sealed source inspect | `/toolkit/source?ticket=` opens a short-lived AES-GCM ticket minted only from server inventory. Re-reads GitHub homepage bytes and shows fingerprints + `editMode`; never embeds raw HTML in the onboarding origin. |
| Site editing | The browser offers the existing #30 editor for eligible generated one-page sites. Imported ZIP sites continue to use their Git workflow. |
| Update status | The open pull request has a Merge link. Closed updates lead back to the editor. Merged updates remain in verification until canonical production SHA and exact approved HTML match. |
| Capability labels | History cards use the #84 `TOOLKIT_CAPABILITY_STATES` vocabulary. Provider-truth `summarizeOwnedToolkitSite` still needs separately verified publication evidence. Analytics / protected previews follow #85 and #86. |

A hosted rollout needs the #21 owner edit and independent customer walkthroughs plus Domain coordination. Rollback is a repository revert.
