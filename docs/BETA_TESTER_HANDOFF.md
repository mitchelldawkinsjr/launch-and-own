# Private-beta tester handoff

**Product:** Launch & Own — *Describe it. Launch it. Own it.*  
**Audience:** invited private testers and the Backend/QA agent (#21)  
**Status:** offline beta kit is ready now; hosted sign-in is **not** ready

## Entry point (available today)

Private ChatGPT / plugin distribution is **not** available. The independent tester entry point is this repository’s **zero-account beta kit**:

1. Clone https://github.com/mitchelldawkinsjr/launch-and-own
2. Use **Node.js 22.5+** (CI uses Node 22; Node 22.0.0 is too old because `node:sqlite` is missing)
3. From the repo root:

```sh
npm run demo:export
npm run demo:serve
```

4. Open **http://127.0.0.1:4173/** on the same machine
5. Click through Home → About → Services → Contact for the fictional Willow Studio sample

That is the first preview. It uses the same production HTML renderer and prints a full-bundle SHA-256. It does **not** create GitHub or Cloudflare resources and is **not** a launch approval.

Longer detail: [offline preview notes](OFFLINE_BETA_PREVIEW.md).

## Prerequisites

| Need | Now | Later (hosted pilot) |
| --- | --- | --- |
| Node 22.5+ | Required | Required for local checks |
| GitHub account | Not required for the beta kit | Required; customer’s own account |
| Cloudflare account | Not required for the beta kit | Required; customer’s own account |
| Invitation / access | Repo clone or private invite | Domain agent confirms `https://onboard.360web.cloud` sign-ins in #2 |
| Money / AI | None for the beta kit | Optional Workers AI only after explicit owner approval |

## Account connections, preview, approval (honest status)

- **Offline kit:** no account connection. Preview only.
- **Hosted onboarding origin:** `https://onboard.360web.cloud` — **not verified live** yet (Domain/OAuth stream on #2). Do not send testers there until Domain posts that both GitHub and Cloudflare sign-ins work.
- **Approval / launch / live edit:** Backend/QA owns the independent live run in [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21) after Domain’s go-ahead.

## Custom brief (optional)

Do **not** append flags to `npm run demo:export` (that script already has defaults). Call the exporter directly and pick a **new** output folder every time:

```sh
node scripts/export-preview.mjs --input path/to/your-brief.json --out ./site-preview-my-biz
node scripts/serve-preview.mjs --dir ./site-preview-my-biz --port 4173
```

Re-running into an existing folder fails on purpose (no overwrite). Remove the old local folder or choose another `--out` name. Only use contact details you are comfortable storing on your machine.

## Where to report a blocker

Post on the coordination hub: [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

| Tag | Use for |
| --- | --- |
| `[PRODUCT]` | Confusing kit steps, handoff wording, distribution |
| `[DOMAIN]` | Hosted hostname, OAuth apps, TLS, secrets |
| `[BACKEND]` / QA | Live launch/update verification (#21) |
| `[CODEX MAX]` | Durable jobs / recovery (#12) |

Do **not** paste OAuth secrets, encryption keys, or personal submissions into GitHub.

## Starter / blueprint status

| Surface | Status |
| --- | --- |
| Repo beta kit (`demo:export` / `demo:serve`) | **Ready** for invited testers |
| Public ChatGPT plugin / store listing | **Not available** (later decision) |
| Hosted `onboard.360web.cloud` login | **Blocked** on Domain/OAuth completion |
| Live independent launch + approved update | **Queued** for QA (#21) after Domain confirms sign-ins |
| Project license / public reuse terms | **Not decided** |

## Fresh-walkthrough evidence (product agent)

Recorded while completing [#22](https://github.com/mitchelldawkinsjr/launch-and-own/issues/22):

- `npm run demo:export` → 4 pages + bundle SHA-256 `6dcee41d77c95bc26ea48dd38e4e7ff3b6f9e65fa244fe365fd122dc23ed2aa9` for `examples/willow-studio.json`
- `npm run demo:serve` → Home/About/Services/Contact each HTTP 200 on loopback; `preview-manifest.json` and random paths return 404
- Node 20 / Node 22.0.0: `npm test` fails (`node:sqlite` missing); Node 24.21.0: **180/180** tests pass
- Confusing steps fixed in this PR: clearer “directory already exists” export error, Node `>=22.5.0` engines note, this handoff doc

**QA coordination:** the same tester can keep this kit open, then continue into the live pilot on #21 once Domain confirms both hosted sign-ins in #2.
