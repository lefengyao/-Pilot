import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminAuth, AdminAuthError } from '../server/admin-auth.js';

test('unlocks with a valid key and verifies a client-bound token', () => {
  let now = 1000;
  const auth = new AdminAuth({ key: 'k'.repeat(32), ttlMs: 100, now: () => now, tokenFactory: () => 'token-a' });

  const grant = auth.unlock('k'.repeat(32), 'browser-a', '127.0.0.1');
  assert.deepEqual(grant, { token: 'token-a', expiresAt: 1100 });
  assert.equal(auth.verify('token-a', 'browser-a'), true);
  assert.equal(auth.verify('token-a', 'browser-b'), false);
  now = 1100;
  assert.equal(auth.verify('token-a', 'browser-a'), false);
});

test('rejects wrong keys, missing configuration, and excessive failures', () => {
  const auth = new AdminAuth({ key: 'k'.repeat(32), maxAttempts: 2, windowMs: 1000, now: () => 1000, tokenFactory: () => 'token-b' });
  assert.throws(() => auth.unlock('wrong', 'browser-a', '10.0.0.1'), (error) => error instanceof AdminAuthError && error.status === 401);
  assert.throws(() => auth.unlock('wrong', 'browser-a', '10.0.0.1'), (error) => error instanceof AdminAuthError && error.status === 401);
  assert.throws(() => auth.unlock('k'.repeat(32), 'browser-a', '10.0.0.1'), (error) => error instanceof AdminAuthError && error.status === 429);
  const disabled = new AdminAuth({ key: null });
  assert.throws(() => disabled.unlock('anything', 'browser-a', '127.0.0.1'), (error) => error instanceof AdminAuthError && error.status === 404);
});
