-- Encrypt and rotate OAuth refresh credentials independently for each provider.
-- Nullable for older sessions and providers that issue non-expiring tokens.
-- Do not copy tokens or session data from another database.
ALTER TABLE onboarding_sessions ADD COLUMN github_refresh_token_ct TEXT;
ALTER TABLE onboarding_sessions ADD COLUMN github_token_expires_at INTEGER;
ALTER TABLE onboarding_sessions ADD COLUMN github_refresh_expires_at INTEGER;
ALTER TABLE onboarding_sessions ADD COLUMN github_refresh_locked_until INTEGER;
ALTER TABLE onboarding_sessions ADD COLUMN cloudflare_refresh_token_ct TEXT;
ALTER TABLE onboarding_sessions ADD COLUMN cloudflare_token_expires_at INTEGER;
ALTER TABLE onboarding_sessions ADD COLUMN cloudflare_refresh_expires_at INTEGER;
ALTER TABLE onboarding_sessions ADD COLUMN cloudflare_refresh_locked_until INTEGER;
