# Cloudflare Pages PR preview policy (#86)

Approved launches use `preview_deployment_setting: none`. The read-only audit sampled three owner QA projects with preview builds disabled. The policy helper describes current build configuration and proposed settings, with Access protection reported separately. [Audit](POST_LAUNCH_TOOLKIT_AUDIT.md) · [Provider settings](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)

| State | Observed build settings |
| --- | --- |
| `off` | Preview builds disabled. Previously built deployments may still resolve. |
| `scoped` | Custom includes exactly `launch-and-own/site-*`, excludes `main` and explicitly disables native PR comments. |
| `unsafe_all` | Preview builds enabled for all non-production branches. |
| `unsafe_custom` | Other custom settings, including missing or enabled native PR comments. |
| `unknown` | Settings unavailable or unsupported. |


## Toolkit status

The toolkit status adapter reads one Pages project using the currently linked owner's Cloudflare session and the verified managed-site reference. It matches the immutable project, repository and owner identities against the response, then reports whether builds are disabled, scoped, broadly configured or unknown. The adapter also reports expired grants, missing permission and unavailable settings. These labels describe automatic build settings. Preview access and the exact pull request revision still require separate verification.

The panel keeps preview and PR URLs private. Existing preview deployments may still be reachable when new builds are off. The preview policy and private exact-review flow are subject to independent owner acceptance. [Protected preview acceptance](TOOLKIT_PREVIEW_ACCEPTANCE.md)

The review plan binds the selected account, immutable project and GitHub identities and expected static configuration. A proposed enablement plan explains the narrow scope and the Access requirement. An approval and execution design requires its own review and must recheck owner authorization and exact access policy before any eligible push. Cloudflare's native GitHub checks may still expose a link. Check both actual allowed and denied requests for every preview host, including aliases and retained deployments. [Acceptance and rollback](TOOLKIT_PREVIEW_ACCEPTANCE.md)

Cloudflare Pages previews are public by default. Each preview uses the applicable account's Pages build allowance. Pages Free includes 500 builds per month and one concurrent build. The current Pages grant provides project metadata. Access policy verification uses separate permissions. [Preview access](https://developers.cloudflare.com/pages/configuration/preview-deployments/) · [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

In Domain's separately approved owner-QA trial, a scoped settings change was read back and then returned to disabled. The earlier configuration included an inactive wildcard which ended as an empty include list. The Git connection and production HTTP reachability were observed. The protected pilot still needs access evidence and the exact production SHA and HTML before and after. [Trial evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/86#issuecomment-7089724208)
