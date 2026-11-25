-- Dedicated MCP bridge D1. Never point at a customer's contact-form database.
-- Prefer a separate database from onboarding beta until Domain reviews sharing.

CREATE TABLE IF NOT EXISTS bridge_link_challenges (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expected_github_user_id INTEGER,
  expected_cloudflare_account_id TEXT,
  expected_authorization_epoch INTEGER,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bridge_challenges_subject
  ON bridge_link_challenges(subject, client_id, expires_at);

CREATE TABLE IF NOT EXISTS bridge_owner_links (
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  reauthorized INTEGER NOT NULL CHECK(reauthorized IN (0, 1)),
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (subject, client_id)
);

CREATE TABLE IF NOT EXISTS bridge_agent_tokens (
  token_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bridge_tokens_expires ON bridge_agent_tokens(expires_at);

CREATE TABLE IF NOT EXISTS bridge_sites (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_sites_owner
  ON bridge_sites(subject, github_user_id, cloudflare_account_id, authorization_epoch);

CREATE TABLE IF NOT EXISTS bridge_drafts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  state TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create', 'update')),
  preview_sha256 TEXT NOT NULL,
  site_spec_json TEXT,
  changes_json TEXT,
  site_id TEXT,
  base_commit_sha TEXT,
  repository_id INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_drafts_owner
  ON bridge_drafts(subject, github_user_id, cloudflare_account_id, authorization_epoch);

CREATE TABLE IF NOT EXISTS bridge_jobs (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  site_id TEXT,
  approved_html_sha256 TEXT,
  canonical_production_verified INTEGER NOT NULL DEFAULT 0,
  public_html_verified INTEGER NOT NULL DEFAULT 0,
  production_commit_sha TEXT,
  verified_commit_sha TEXT,
  public_html_sha256 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_jobs_owner
  ON bridge_jobs(subject, github_user_id, cloudflare_account_id, authorization_epoch);

CREATE TABLE IF NOT EXISTS bridge_approval_idempotency (
  subject TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subject, draft_id, idempotency_key)
);
