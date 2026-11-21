-- Dedicated onboarding D1. Never run against a customer's contact-form database.
CREATE TABLE IF NOT EXISTS onboarding_flows (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github','cloudflare')),
  binding_hash TEXT NOT NULL,
  verifier_ct TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_onboarding_flows_expires ON onboarding_flows(expires_at);

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id_hash TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  github_token_ct TEXT NOT NULL,
  cloudflare_token_ct TEXT,
  cloudflare_account_id TEXT,
  csrf_ct TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_expires ON onboarding_sessions(expires_at);

CREATE TABLE IF NOT EXISTS onboarding_launches (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preview','approved','provisioning','pending_deployment','live','failed')),
  provision_result TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(session_hash) REFERENCES onboarding_sessions(id_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_onboarding_launches_session ON onboarding_launches(session_hash,created_at);
