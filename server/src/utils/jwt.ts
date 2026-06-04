import * as jose from 'jose';
import { getEnv } from '../config.js';

const secret = new TextEncoder().encode(getEnv().JWT_SECRET);

export async function signJWT(payload: Record<string, unknown>, expiresIn = '7d') {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export async function verifyJWT(token: string) {
  const { payload } = await jose.jwtVerify(token, secret);
  return payload;
}
