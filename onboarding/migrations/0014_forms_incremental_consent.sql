-- Incremental consent (owner-approved 2026-11-26): forms scopes (Workers Scripts Admin, D1 write) are no longer
-- requested at sign-in, only when an owner turns on forms. Additive; existing code ignores both columns.
ALTER TABLE onboarding_flows ADD COLUMN purpose TEXT NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in', 'forms'));
ALTER TABLE onboarding_sessions ADD COLUMN cloudflare_forms_grant INTEGER NOT NULL DEFAULT 0 CHECK (cloudflare_forms_grant IN (0, 1));
