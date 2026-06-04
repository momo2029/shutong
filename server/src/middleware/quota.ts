import { createMiddleware } from 'hono/factory';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const quotaMiddleware = createMiddleware(async (c, next) => {
  const user = c.get('user');
  if (!user) return next();

  const current = db.select().from(users).where(eq(users.id, user.id)).get();
  if (current && current.storageUsed >= current.storageLimit) {
    return c.json({ error: 'Storage quota exceeded' }, 413);
  }
  await next();
});
