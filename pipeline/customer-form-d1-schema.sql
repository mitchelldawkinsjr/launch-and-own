-- Customer-owned contact-form D1 schema (#89).
-- Deploy only into the customer's dedicated forms database — never the
-- Launch & Own onboarding D1, and never the platform ZIP staging store.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  gate_approval_id TEXT NOT NULL,
  fields_json TEXT NOT NULL CHECK(length(fields_json) BETWEEN 2 AND 65536),
  reply_email TEXT CHECK(reply_email IS NULL OR length(reply_email) BETWEEN 3 AND 254),
  body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 1 AND 65536),
  turnstile_hostname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_day
  ON contact_submissions (hostname, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_gate
  ON contact_submissions (gate_approval_id, created_at);

CREATE TABLE IF NOT EXISTS turnstile_token_uses (
  token_hash TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turnstile_token_uses_day
  ON turnstile_token_uses (hostname, used_at);
