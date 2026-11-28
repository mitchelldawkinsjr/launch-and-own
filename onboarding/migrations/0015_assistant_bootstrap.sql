-- Hosted assistant bootstrap (owner-accepted ADR-001 D-style pilot). Incremental consent purpose=assistant
-- and non-secret bootstrap receipts. Secrets (KEK, GH_APP_PRIVATE_KEY) never land in onboarding D1.
-- Rebuild flows: SQLite/D1 cannot widen CHECK constraints in place.
CREATE TABLE onboarding_flows_v15 (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github','cloudflare')),
  binding_hash TEXT NOT NULL,
  verifier_ct TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  purpose TEXT NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in', 'forms', 'assistant'))
);
INSERT INTO onboarding_flows_v15
  (state_hash, provider, binding_hash, verifier_ct, expires_at, consumed_at, purpose)
SELECT state_hash, provider, binding_hash, verifier_ct, expires_at, consumed_at, purpose
FROM onboarding_flows;
DROP TABLE onboarding_flows;
ALTER TABLE onboarding_flows_v15 RENAME TO onboarding_flows;
CREATE INDEX IF NOT EXISTS idx_onboarding_flows_expires ON onboarding_flows(expires_at);

ALTER TABLE onboarding_sessions ADD COLUMN cloudflare_assistant_grant INTEGER NOT NULL DEFAULT 0
  CHECK (cloudflare_assistant_grant IN (0, 1));

-- One bootstrap run per live launch job. Step status and provider IDs only — never pem/KEK.
CREATE TABLE IF NOT EXISTS onboarding_assistant_bootstrap (
  job_id TEXT PRIMARY KEY REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  site_slug TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN (
    'consent','cf_grant','create','access','github_app','install','ready','failed'
  )),
  assistant_repo TEXT,
  worker_name TEXT,
  d1_id TEXT,
  worker_origin TEXT,
  upstream_sha TEXT,
  created_this_run_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (github_user_id > 0)
);
CREATE INDEX IF NOT EXISTS idx_assistant_bootstrap_owner
  ON onboarding_assistant_bootstrap(github_user_id, cloudflare_account_id);
