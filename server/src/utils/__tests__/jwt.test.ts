import { describe, it, expect, beforeAll } from 'vitest';

describe('jwt', () => {
  beforeAll(() => {
    // jwt.ts reads JWT_SECRET at module import time
    process.env.JWT_SECRET = 'test-secret-for-jwt-test';
  });

  it('signs and verifies a JWT token', async () => {
    const { signJWT, verifyJWT } = await import('../jwt.js');

    const payload = { sub: 'user-123', email: 'test@example.com' };
    const token = await signJWT(payload);

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.signature

    const decoded = await verifyJWT(token);
    expect(decoded.sub).toBe('user-123');
    expect(decoded.email).toBe('test@example.com');
  });

  it('rejects an invalid token', async () => {
    const { verifyJWT } = await import('../jwt.js');

    await expect(verifyJWT('fake.token.here')).rejects.toThrow();
  });

  it('supports custom expiration', async () => {
    const { signJWT, verifyJWT } = await import('../jwt.js');

    const token = await signJWT({ sub: 'test' }, '1h');
    const decoded = await verifyJWT(token);
    expect(decoded.sub).toBe('test');
  });
});
