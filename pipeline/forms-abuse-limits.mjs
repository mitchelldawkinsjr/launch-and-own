// Per-customer form abuse, retention, and body limits (#89).
// Pure helpers for a future customer-owned form Worker. No D1 writes here.

export function assertFormSubmissionLimits({
  bodyBytes,
  submissionsToday,
  maxBodyBytes,
  maxSubmissionsPerDay
} = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > 65536)
    return Object.freeze({ok: false, reason: 'max_body_bytes_invalid'});
  if (!Number.isSafeInteger(maxSubmissionsPerDay) ||
      maxSubmissionsPerDay < 1 || maxSubmissionsPerDay > 1000)
    return Object.freeze({ok: false, reason: 'max_submissions_per_day_invalid'});
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0)
    return Object.freeze({ok: false, reason: 'body_bytes_invalid'});
  if (bodyBytes > maxBodyBytes)
    return Object.freeze({ok: false, reason: 'body_too_large'});
  if (!Number.isSafeInteger(submissionsToday) || submissionsToday < 0)
    return Object.freeze({ok: false, reason: 'submissions_today_invalid'});
  if (submissionsToday >= maxSubmissionsPerDay)
    return Object.freeze({ok: false, reason: 'daily_quota_exhausted'});
  return Object.freeze({ok: true, reason: null});
}

/** Rows older than retentionDays must be deleted; Git revert does not erase them. */
export function submissionRetentionCutoff({retentionDays, nowSec = Math.floor(Date.now() / 1000)} = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)
    throw Object.assign(new Error('retention_days_invalid'), {code: 'retention_days_invalid'});
  if (!Number.isSafeInteger(nowSec) || nowSec < 1)
    throw Object.assign(new Error('clock_invalid'), {code: 'clock_invalid'});
  return nowSec - (retentionDays * 86400);
}

export function shouldDeleteSubmission({createdAt, retentionDays, nowSec} = {}) {
  const cutoff = submissionRetentionCutoff({retentionDays, nowSec});
  if (!Number.isSafeInteger(createdAt) || createdAt < 1) return true;
  return createdAt < cutoff;
}
