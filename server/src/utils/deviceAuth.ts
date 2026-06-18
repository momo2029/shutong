import { createHmac, timingSafeEqual } from 'crypto';
import { getEnv } from '../config.js';

const DEVICE_USERNAME_SKEW_SECONDS = 300;
const DEVICE_RELATIVE_TIMESTAMP_MAX_SECONDS = 24 * 60 * 60;
const DEVICE_UNIX_TIMESTAMP_THRESHOLD_SECONDS = 1_000_000_000;

export function normalizeDeviceSn(clientid: string): string {
  return clientid.startsWith('st_') ? clientid.substring(3) : clientid;
}

export function verifyDeviceUsername(username: string | undefined, clientid: string): { ok: true; type: string } | { ok: false; reason: string } {
  if (!username) {
    return { ok: false, reason: 'missing_username' };
  }

  // 生产环境只允许签名认证或服务端下发的个性化凭据。
  if (process.env.NODE_ENV !== 'production' && (username === 'st_device' || username.startsWith('st_'))) {
    return { ok: true, type: 'fixed' };
  }

  const parts = username.split(':');
  if (parts.length !== 3) {
    return { ok: false, reason: 'invalid_username_format' };
  }

  const [type, timestampText, signature] = parts;
  if (!type || !timestampText || !signature) {
    return { ok: false, reason: 'invalid_username_format' };
  }

  const timestamp = Number(timestampText);
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  if (timestamp < DEVICE_UNIX_TIMESTAMP_THRESHOLD_SECONDS) {
    if (timestamp > DEVICE_RELATIVE_TIMESTAMP_MAX_SECONDS) {
      return { ok: false, reason: 'relative_timestamp_out_of_range' };
    }
  } else {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > DEVICE_USERNAME_SKEW_SECONDS) {
      return { ok: false, reason: 'timestamp_out_of_range' };
    }
  }

  const masterKey = getEnv().DEVICE_MASTER_KEY;
  if (!masterKey) {
    return { ok: false, reason: 'missing_device_master_key' };
  }

  const sn = normalizeDeviceSn(clientid);
  const payload = `${type}|${timestampText}|${sn}`;
  const expected = createHmac('sha256', masterKey)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true, type };
}

export function verifyPersonalizedDevicePassword(username: string | undefined, password: string | undefined, clientid: string): boolean {
  if (!username || !password) return false;
  const sn = normalizeDeviceSn(clientid);
  if (username !== `st_${sn}`) return false;

  const masterKey = getEnv().DEVICE_MASTER_KEY;
  if (!masterKey) return false;

  const expected = createHmac('sha256', masterKey)
    .update(sn)
    .digest('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 32);
  return safeEqual(password, expected);
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}
