# Post-launch website toolkit (#87)

The first toolkit view shows retained launch history for the connected GitHub user and selected Cloudflare account. Successful records include the public address, GitHub revision and time recorded when the launch was verified. The approval fingerprint identifies the approved snapshot. It does not establish a public HTML digest or current deployment.

| Surface | Behavior |
| --- | --- |
| `GET /toolkit` | Shows up to 20 launch records from the 30-day retention window. Reads display fields in one scoped query and rechecks the authorization epoch before returning them. |
| Site editing | The browser offers the existing #30 editor for eligible generated one-page sites. Imported ZIP sites continue to use their Git workflow. |
| Update status | The open pull request has a Merge link. Closed updates lead back to the editor. Merged updates remain in verification until canonical production SHA and exact approved HTML match. |
| Additional capabilities | Current provider links and deployment status need verified #39 inventory. Analytics and protected preview integration follow #85 and #86. |

A hosted rollout needs the #21 owner edit and independent customer walkthroughs plus Domain coordination. Rollback is a repository revert.
