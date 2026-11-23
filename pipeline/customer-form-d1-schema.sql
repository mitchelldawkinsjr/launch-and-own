-- Customer-owned contact-form D1 schema (#89).
-- Deploy only into the customer's dedicated forms database — never the
-- Launch & Own onboarding D1, and never the platform ZIP staging store.
CREATE TABLE contact_submissions (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  gate_approval_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 90),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 1 AND 65536),
  turnstile_hostname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_contact_submissions_day
  ON contact_submissions (hostname, created_at);
CREATE INDEX idx_contact_submissions_gate
  ON contact_submissions (gate_approval_id, created_at);

CREATE TABLE turnstile_token_uses (
  token_hash TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX idx_turnstile_token_uses_day
  ON turnstile_token_uses (hostname, used_at);
