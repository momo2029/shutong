import { createMiddleware } from 'hono/factory';
import { verifyJWT } from '../utils/jwt.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Vars } from '../app.js';

export const authMiddleware = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const payload = await verifyJWT(match[1]);
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
