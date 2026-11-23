-- #89: per-step provisioning receipts for one approved forms request. Written only
-- by the operator-approved execution after each Cloudflare step succeeds, so an
-- interrupted run resumes by reconciling these IDs instead of creating duplicates.
-- Owner acceptance is recorded separately (accepted_at). No secrets are stored:
-- the Turnstile secret is re-read from Cloudflare on resume.
CREATE TABLE onboarding_forms_provisioning (
  forms_option_approval_id TEXT PRIMARY KEY
    REFERENCES onboarding_option_approvals(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL CHECK(github_user_id > 0),
  cloudflare_account_id TEXT NOT NULL,
  gate_approval_id TEXT NOT NULL,
  widget_sitekey TEXT,
  database_id TEXT CHECK(database_id IS NULL OR length(database_id) = 36),
  schema_applied INTEGER NOT NULL DEFAULT 0 CHECK(schema_applied IN (0, 1)),
  worker_etag TEXT,
  endpoint TEXT,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_forms_provisioning_owner
  ON onboarding_forms_provisioning (github_user_id, cloudflare_account_id, job_id);
