import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFormSubmissionLimits,
  shouldDeleteSubmission,
  submissionRetentionCutoff
} from './forms-abuse-limits.mjs';

test('body and daily quota limits fail closed at the boundary', () => {
  assert.deepEqual(assertFormSubmissionLimits({
    bodyBytes: 4096, submissionsToday: 49,
    maxBodyBytes: 4096, maxSubmissionsPerDay: 50
  }), {ok: true, reason: null});
  assert.equal(assertFormSubmissionLimits({
    bodyBytes: 4097, submissionsToday: 0,
    maxBodyBytes: 4096, maxSubmissionsPerDay: 50
  }).reason, 'body_too_large');
  assert.equal(assertFormSubmissionLimits({
    bodyBytes: 10, submissionsToday: 50,
    maxBodyBytes: 4096, maxSubmissionsPerDay: 50
  }).reason, 'daily_quota_exhausted');
});

test('retention cutoff deletes aged personal submissions', () => {
  const now = 1_700_000_000;
  assert.equal(submissionRetentionCutoff({retentionDays: 30, nowSec: now}),
    now - 30 * 86400);
  assert.equal(shouldDeleteSubmission({
    createdAt: now - 31 * 86400, retentionDays: 30, nowSec: now
  }), true);
  assert.equal(shouldDeleteSubmission({
    createdAt: now - 10 * 86400, retentionDays: 30, nowSec: now
  }), false);
});
