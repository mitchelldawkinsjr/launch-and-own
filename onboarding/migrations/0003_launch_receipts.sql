-- Session-independent, bounded history of explicitly approved customer launches.
-- Contains customer-authored website copy and verified owner/account identifiers,
-- but deliberately stores NO OAuth grants, secrets, cookies or session hashes.
-- Preview-only plans are never inserted. Expire receipts after 30 days.
CREATE TABLE IF NOT EXISTS onboarding_launch_receipts (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('approved','provisioning','pending_deployment','live','failed')),
  approved_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_receipts_owner
  ON onboarding_launch_receipts(github_user_id,cloudflare_account_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_onboarding_receipts_expiry
  ON onboarding_launch_receipts(expires_at);
