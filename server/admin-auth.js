import crypto from 'node:crypto';

export class AdminAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AdminAuthError';
    this.status = status;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export class AdminAuth {
  constructor({ key, ttlMs = 15 * 60 * 1000, maxAttempts = 5, windowMs = 60 * 1000, now = Date.now, tokenFactory = () => crypto.randomBytes(32).toString('base64url') }) {
    this.key = typeof key === 'string' && key.length > 0 ? digest(key) : null;
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.tokens = new Map();
    this.failures = new Map();
  }

  unlock(candidate, clientId, address) {
    if (!this.key) throw new AdminAuthError('管理员功能未启用。', 404);
    const current = this.now();
    const attempts = this.failures.get(address);
    if (attempts && current - attempts.startedAt < this.windowMs && attempts.count >= this.maxAttempts) {
      throw new AdminAuthError('尝试次数过多，请稍后再试。', 429);
    }
    const valid = typeof candidate === 'string' && crypto.timingSafeEqual(this.key, digest(candidate));
    if (!valid) {
      const next = attempts && current - attempts.startedAt < this.windowMs
        ? { startedAt: attempts.startedAt, count: attempts.count + 1 }
        : { startedAt: current, count: 1 };
      this.failures.set(address, next);
      throw new AdminAuthError('管理员密钥错误。', 401);
    }
    this.failures.delete(address);
    const token = this.tokenFactory();
    const expiresAt = current + this.ttlMs;
    this.tokens.set(token, { clientId, expiresAt });
    return { token, expiresAt };
  }

  verify(token, clientId) {
    if (typeof token !== 'string' || typeof clientId !== 'string') return false;
    const grant = this.tokens.get(token);
    if (!grant) return false;
    if (grant.expiresAt <= this.now() || grant.clientId !== clientId) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
}
