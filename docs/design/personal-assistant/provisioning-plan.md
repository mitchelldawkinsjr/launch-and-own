# Provisioning plan (WS4)

Design only, 2026-11-24 · Claude Opus 5.5. This assumes the customer-run deploy (ADR-001 B1), the per-customer App with local exchange (ADR-002 A3) and the separate private repo (ADR-003). **Nothing here may run against real accounts before the explicit test-account authorization required for M2.**

## Resource manifest

A versioned JSON document in the assistant repo (`provisioning/manifest.json`). The setup script reads it to plan, show the consent screen, resume and roll back. Every resource uses a deterministic name derived from `siteSlug`, so the script can check whether a resource exists before creating it.

```json
{
  "manifestVersion": 1,
  "assistantVersion": "0.1.0",
  "upstreamSha": "<40-hex>",
  "siteSlug": "<slug>",
  "runId": "<uuid, set per run>",
  "resources": [
    {"id": "assistant-repo",  "provider": "github",     "kind": "private_repo",     "name": "<owner>/<slug>-assistant", "createdBy": "customer-script", "cost": "free",          "rollback": "delete_if_created_this_run"},
    {"id": "d1",              "provider": "cloudflare", "kind": "d1_database",      "name": "lo-assistant-<slug>",      "createdBy": "wrangler",        "cost": "free_tier",     "limits": "1 of 10 DBs, 500 MB",        "rollback": "delete_if_created_this_run"},
    {"id": "worker",          "provider": "cloudflare", "kind": "worker_script",    "name": "lo-assistant-<slug>",      "createdBy": "wrangler",        "cost": "free_tier",     "limits": "1 of 100 Workers",           "bindings": ["DB", "AI"], "rollback": "delete_if_created_this_run"},
    {"id": "preview-worker",  "provider": "cloudflare", "kind": "worker_script",    "name": "lo-assistant-<slug>-preview", "createdBy": "wrangler",     "cost": "free_tier",     "bindings": ["PREVIEW_READ"], "secrets": [], "rollback": "delete_if_created_this_run"},
    {"id": "secrets",         "provider": "cloudflare", "kind": "worker_secrets",   "names": ["KEK", "GH_APP_ID", "GH_APP_PRIVATE_KEY", "GH_INSTALLATION_ID"], "createdBy": "wrangler", "cost": "free", "rollback": "deleted_with_worker"},
    {"id": "access-app",      "provider": "cloudflare", "kind": "access_application", "name": "Launch & Own Assistant (<slug>)", "createdBy": "customer-manual", "cost": "zero_trust_free (seat limit unverified)", "rollback": "manual_checklist"},
    {"id": "github-app",      "provider": "github",     "kind": "github_app",       "name": "<slug>-assistant",         "createdBy": "manifest-local-exchange", "permissions": {"contents": "write", "pull_requests": "write", "metadata": "read"}, "webhook": false, "cost": "free", "rollback": "manual_checklist"},
    {"id": "app-install",     "provider": "github",     "kind": "app_installation", "repos": ["<website repo id>"], "createdBy": "customer-manual", "rollback": "deleted_with_app"}
  ],
  "workersAi": {"dailyNeuronBudget": 8000, "models": ["<from WS2 eval>"]},
  "noCron": true
}
```

Notes on the choices:
- **Preview storage uses D1, not R2.** R2 enablement and its billing prerequisites are unverified for this plan. The preview Worker gets a read-only view of the preview artifacts and nothing else.
- **No cron triggers.** The account allows only 5, and the customer may already use them.

## Step order (each step is idempotent)

| # | Step | Checks before | Verifies after | If it fails |
| --- | --- | --- | --- | --- |
| 0 | Preflight | Node ≥ 22.12. Signed in with `wrangler whoami` on the intended account. Fewer than 10 D1 databases and fewer than 100 Workers. Detect the Workers plan. A Zero Trust team exists. The GitHub login matches the website repo owner. | Report shown, no changes made | Stop. Nothing to roll back. |
| 1 | Create the assistant repo from the template at `upstreamSha` | The repo name is free, or it already exists with a matching `upstreamSha` | The repo exists and is private. If the owner opted in, Actions PR creation is on for this repo only. | Delete it only if this run created it |
| 2 | `wrangler d1 create` + `migrations apply --remote` | The name is free, or the DB has the expected migrations table | Migration list matches | Delete the DB only if this run created it |
| 3 | Deploy the Worker in **bootstrap mode** + `secret put KEK` | — | `/healthz` responds. Every other route returns 503 "Access not configured". | `wrangler delete` if created this run |
| 4 | **Manual:** create the Access application and policy (deep link plus exact values). Allow only the owner's email. Session duration ≤ 24 hours. Cover the custom hostname or `workers.dev`, and the preview hostname if it should be owner-only. | — | Script asks for the team domain and AUD, sets them as vars, and redeploys. A browser visit with a valid JWT shows `/status` with `access: ok`. | The Worker stays fail-closed. Resume at step 4. |
| 5 | Local manifest exchange (ADR-002 A3) → `secret put GH_APP_ID`, `GH_APP_PRIVATE_KEY` | An app with this name doesn't already exist | The secret is listed by name. The key never touches disk. | The code expires in 1 hour, so restart the step. If the app was created but the secret wasn't set, the guide says to delete the app or reuse it after generating a new key. |
| 6 | **Manual:** install the app on **only** the website repo → `secret put GH_INSTALLATION_ID`, var `WEBSITE_REPO_ID` | — | Self-check: mint a token restricted to the repo, call `GET /repos/{id}`, then the token expires on its own | — |
| 7 | Self-check and activate | — | Access ok · GitHub read ok (no write) · AI call within budget · D1 write ok · version and SHA reported | Dashboard shows the failing check. No activation. |

**Resume:** the script writes `provisioning/state.<runId>.json` locally. It holds resource IDs and step status, never secrets. On restart it re-runs each step's "checks before" so it doesn't trust stale state.

**Rollback:** the reverse order of the steps that **this run** completed. It never deletes a resource that existed before the run. Manual resources (Access, GitHub App) get a printed checklist rather than automated deletion.

## Consent and cost review screen (draft copy)

> **Set up your private website assistant**
>
> This creates the following in **your** accounts. Launch & Own does not receive access to any of it.
>
> **GitHub (`<login>`)**
> - Private repository `<slug>-assistant` (assistant code; no passwords stored in it)
> - *Optional:* allow GitHub Actions to open update pull requests in that repository **only**. A weekly check proposes verified updates, and you review and merge them. Leave it off and the dashboard tells you about updates instead.
> - Private GitHub App `<slug>-assistant`, installed **only** on `<website repo>`. It can read files and open pull requests. It can't merge, change settings or edit workflows. It *can* technically write to any branch; the assistant only writes `assistant/…` branches. You merge every change yourself.
>
> **Cloudflare (`<account name>`)**
> - Worker `lo-assistant-<slug>` and preview Worker `lo-assistant-<slug>-preview`
> - D1 database `lo-assistant-<slug>` (1 of your 10 free databases)
> - Workers AI usage from **your** daily allocation
> - An Access application that lets only `<owner email>` sign in (you create this in the Cloudflare dashboard)
>
> **Cost.** On the Workers **Free** plan these fit within free limits: 100,000 requests/day, 10,000 Workers AI Neurons/day, and D1's free rows and storage. If a daily limit is reached, the assistant **stops working until the next day (midnight UTC)**. You are not charged. The assistant also stops itself at 80% of the daily AI allocation. `<If Workers Paid detected:>` **Your account is on Workers Paid. Usage above the included amounts is billed by Cloudflare (Workers AI: $0.011 per 1,000 Neurons). The assistant's daily budget limits this, but Cloudflare bills your account directly.** Domain registration and other services are separate. Limits are set by the providers and can change.
>
> **Removing it.** Delete the GitHub App, the Workers, the D1 database and the Access application. The removal guide lists each one. Your website and its history stay untouched.
>
> ☐ I understand what will be created and that I pay any provider charges on my account
> ☐ I will review and merge every change myself
>
> [Create resources] [Cancel]

Copy rules: no "free forever" or "guaranteed $0". Show the limits with their source dates. Keep the Paid-plan warning prominent.

## Free-tier limits relied on

Read 2026-11-24. Re-verify before M2 and at every release.

| Limit | Value | Source (page modified) |
| --- | --- | --- |
| Worker requests | 100,000/day; Error 1027 above | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (2026-11-19) |
| Worker CPU per request | 10 ms | same |
| Subrequests per request | 50 | same |
| Workers per account | 100 | same |
| Cron triggers per account | 5 (we use 0) | same |
| D1 databases / size / account storage | 10 / 500 MB / 5 GB | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) (2026-11-20) |
| D1 rows read / written | 5M / 100k per day | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (2026-11-18) |
| D1 queries per invocation | 50 (a batch counts as one) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Workers AI | 10,000 Neurons/day; on Free, fails above that; on Paid, $0.011 per 1k | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (2026-11-18) |
| Access applications | 500 (Zero Trust Free); **seat limit unverified** | [Zero Trust account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) (2026-11-17) |
| Pages builds | 500/month, 1 concurrent | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) (2026-11-19) |

**CPU risk.** 10 ms per request is tight for JWT verification, hashing changed files and assembling a tree. WS3 must measure CPU on realistic sites during M1.5. If it goes over, there are two choices: smaller per-request steps, or stating that Workers Paid is needed (with consent). Never a silent upgrade.
