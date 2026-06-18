import { createMiddleware } from 'hono/factory';
import { verifyJWT } from '../utils/jwt.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Vars } from '../app.js';

// 从请求中提取 token：优先 Authorization: Bearer，其次 cookie（兼容网页）
export function extractToken(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const authHeader = c.req.header('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1];
  const cookie = c.req.header('cookie') || '';
  const cookieMatch = cookie.match(/token=([^;]+)/);
  return cookieMatch?.[1] || null;
}

export const authMiddleware = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const payload = await verifyJWT(token);
    const u = db.select().from(users).where(eq(users.id, payload.sub as string)).get();
    if (!u) return c.json({ error: 'User not found' }, 401);
    c.set('user', {
      id: u.id, email: u.email, nickname: u.nickname,
      role: u.role, plan: u.plan, storageUsed: u.storageUsed, storageLimit: u.storageLimit,
    });
    await next();
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
});
