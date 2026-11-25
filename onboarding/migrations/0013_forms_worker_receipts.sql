-- Forms Worker setup checkpoints (#89). Each step is recorded once, in order, so a
-- retried approval resumes from the last finished step. No secret is ever stored.
ALTER TABLE onboarding_forms_provisioning ADD COLUMN worker_deployed INTEGER NOT NULL DEFAULT 0
  CHECK(worker_deployed IN (0, 1));
ALTER TABLE onboarding_forms_provisioning ADD COLUMN worker_subdomain_enabled INTEGER NOT NULL DEFAULT 0
  CHECK(worker_subdomain_enabled IN (0, 1));
ALTER TABLE onboarding_forms_provisioning ADD COLUMN worker_schedule_set INTEGER NOT NULL DEFAULT 0
  CHECK(worker_schedule_set IN (0, 1));
ALTER TABLE onboarding_forms_provisioning ADD COLUMN worker_url TEXT
  CHECK(worker_url IS NULL OR (worker_url LIKE 'https://%.workers.dev' AND length(worker_url) <= 200));
