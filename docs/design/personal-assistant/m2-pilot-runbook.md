# M2 live pilot runbook

Owner-authorized disposable accounts only. No customer or production resources. Follow [`m2-test-plan.md`](m2-test-plan.md) for pass/fail evidence.

## Preconditions

- Explicit owner authorization that the following accounts are disposable for this pilot.
- GitHub test user + private test website repo (empty or fixture site).
- Cloudflare test account on Workers Free with Zero Trust available.
- Node ≥ 22.12, `npx wrangler login` on the **test** Cloudflare account.
- Pinned upstream SHA for the assistant template.

Until that authorization exists, run only the dry-run below. Do not call live GitHub or Cloudflare create APIs.

## Dry-run (safe anytime)

```bash
node assistant/setup/provision.mjs \
  --site-slug m2pilot \
  --owner disposable-owner \
  --website-repo disposable-owner/m2-website \
  --upstream-sha "$(git rev-parse HEAD)" \
  --email pilot@example.com \
  --dry-run
```

Expect: every step marked `done` with `dryRun: true`, a `assistant/provisioning/state.<runId>.json` with no secrets, and no provider resources.

Unit coverage for resume/rollback: `node --test assistant/setup/provision.test.mjs` (T-DEP-1).

## Live pilot sequence (after authorization)

1. Record authorization comment (who, which accounts, date) on #165 / M2 evidence thread.
2. Run `provision.mjs` **without** `--dry-run` against the disposable accounts.
3. At Access pause: create the Access app per the printed guide; resume with team domain, AUD, owner `sub`.
4. At App install pause: install only on the website repo; resume with installation id + repo id.
5. Execute the m2-test-plan tables (ACC, BOOT, SHA, REV, ISO, INJ, QUO, DEP, CLN) and attach redacted evidence.
6. On failure mid-provision: resume from `state.<runId>.json`, or rollback with only `createdThisRun` resources.
7. After pass: uninstall via [`assistant/UNINSTALL.md`](../../../assistant/UNINSTALL.md) (T-CLN).

## Pilot status

| Gate | Status |
| --- | --- |
| Provision CLI + unit tests (T-DEP-1) | Implemented |
| Dry-run path | Implemented; run before every live attempt |
| Owner-authorized disposable accounts | **Required before live provider calls** |
| Full m2-test-plan evidence pack | Pending live pilot |
| Independent customer acceptance | Out of scope for M2 (AGENTS.md) |

Preview Worker (`lo-assistant-<slug>-preview`) is deferred until full rendered preview ships; sandboxed file preview is enough for this pilot.
