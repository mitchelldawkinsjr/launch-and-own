-- Customer-owned assistant D1. This database lives in the customer's own Cloudflare account.
-- The approvals table is identical to onboarding/migrations/0012 so imported/approval-store.mjs runs unchanged (same library, not a fork).
CREATE TABLE onboarding_imported_edit_approvals (
  approval_id TEXT PRIMARY KEY CHECK (length(approval_id) = 32),
  repository_id INTEGER NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (length(base_commit_sha) = 40),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  owner_provider TEXT NOT NULL CHECK (owner_provider IN ('github', 'cloudflare_access')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 80),
  pull_number INTEGER,
  head_sha TEXT NOT NULL DEFAULT '',
  pull_url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (repository_id, base_commit_sha, artifact_digest)
);

-- One row per UTC day; reserveNeurons() updates it atomically.
CREATE TABLE assistant_usage (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  neurons INTEGER NOT NULL CHECK (neurons >= 0)
);
