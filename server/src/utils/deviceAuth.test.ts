import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';

const masterKey = 'test-master-key';

function signedUsername(sn: string, timestamp: number) {
  const payload = `device|${timestamp}|${sn}`;
  const signature = createHmac('sha256', masterKey)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `device:${timestamp}:${signature}`;
}

function personalizedPassword(sn: string) {
  return createHmac('sha256', masterKey)
    .update(sn)
    .digest('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 32);
}

describe('deviceAuth', () => {
  it('accepts a signed relative timestamp username', async () => {
    vi.stubEnv('DEVICE_MASTER_KEY', masterKey);
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { verifyDeviceUsername } = await import('./deviceAuth.js');

    expect(verifyDeviceUsername(signedUsername('SN001', 60), 'SN001')).toEqual({ ok: true, type: 'device' });
  });

  it('rejects a bad signature', async () => {
    vi.stubEnv('DEVICE_MASTER_KEY', masterKey);
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { verifyDeviceUsername } = await import('./deviceAuth.js');

    const result = verifyDeviceUsername('device:60:bad', 'SN001');
    expect(result.ok).toBe(false);
  });

  it('rejects fixed usernames in production', async () => {
    vi.stubEnv('DEVICE_MASTER_KEY', masterKey);
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { verifyDeviceUsername } = await import('./deviceAuth.js');

    const result = verifyDeviceUsername('st_device', 'SN001');
    expect(result.ok).toBe(false);
  });

  it('accepts personalized credentials for the matching SN', async () => {
    vi.stubEnv('DEVICE_MASTER_KEY', masterKey);
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { verifyPersonalizedDevicePassword } = await import('./deviceAuth.js');

    expect(verifyPersonalizedDevicePassword('st_SN001', personalizedPassword('SN001'), 'SN001')).toBe(true);
    expect(verifyPersonalizedDevicePassword('st_SN002', personalizedPassword('SN001'), 'SN001')).toBe(false);
  });
});
