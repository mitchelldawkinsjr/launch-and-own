import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRequestError } from './provider-errors.mjs';

test('provider throttling is retryable and preserves only a numeric retry hint', () => {
  const error = new ProviderRequestError(new Response('private provider error', {
    status: 403, headers: { 'retry-after': '180' }
  }));
  assert.equal(error.retryable, true);
  assert.equal(error.authorizationLost, false);
  assert.equal(error.retryAfter, 180);
  assert(!error.message.includes('private provider error'));
});

test('provider authorization errors and expected reconciliation conflicts are distinct', () => {
  for (const status of [401, 403]) {
    const error = new ProviderRequestError(new Response(null, { status }));
    assert.equal(error.authorizationLost, true);
    assert.equal(error.retryable, false);
  }
  const conflict = new Response(null, { status: 409 });
  assert.equal(new ProviderRequestError(conflict).retryable, false);
  assert.equal(new ProviderRequestError(conflict, { conflictCanRetry: true }).retryable, true);
  assert.equal(new ProviderRequestError(new Response(null, { status: 503 })).retryable, true);
});
