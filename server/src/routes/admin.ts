import { Hono } from 'hono';
import { raw, db } from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { users, firmware } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

app.use('*', async (c, next) => {
  if (c.var.user.email !== 'admin@shutong.app') return c.json({ error: 'Forbidden' }, 403);
  await next();
});

app.get('/stats', (c) => {
  const userCount = raw.prepare('SELECT count(*) as c FROM users').get() as { c: number };
  const deviceCount = raw.prepare('SELECT count(*) as c FROM devices').get() as { c: number };
  const noteCount = raw.prepare('SELECT count(*) as c FROM notes').get() as { c: number };
  const readyCount = raw.prepare("SELECT count(*) as c FROM notes WHERE status='ready'").get() as { c: number };
  const storageTotal = raw.prepare('SELECT sum(storage_used) as s FROM users').get() as { s: number | null };
  return c.json({ users: userCount.c, devices: deviceCount.c, notes: noteCount.c, readyNotes: readyCount.c, storageUsed: storageTotal.s || 0 });
});

app.get('/users', (c) => {
  const list = db.select().from(users).all().map(u => ({
    id: u.id, email: u.email.replace('@wechat.local', ''), nickname: u.nickname,
    plan: u.plan, storageUsed: u.storageUsed, storageLimit: u.storageLimit, createdAt: u.createdAt,
  }));
  return c.json({ users: list });
});

app.put('/users/:id', async (c) => {
  const { plan, storageLimit } = await c.req.json<{ plan?: string; storageLimit?: number }>();
  const upd: Record<string, unknown> = {};
  if (plan) upd.plan = plan;
  if (storageLimit) upd.storageLimit = storageLimit;
  db.update(users).set(upd).where(eq(users.id, c.req.param('id'))).run();
  return c.json({ ok: true });
});

app.post('/firmware', async (c) => {
  const form = await c.req.formData();
  const file = form.get('firmware') as File | null;
  const version = form.get('version') as string;
  const deviceType = form.get('deviceType') as string;
  const changelog = form.get('changelog') as string || '';
  if (!file || !version || !deviceType) return c.json({ error: '缺少必要参数' }, 400);

  const id = uuid();
  const key = `firmware/${deviceType}_${version}.bin`;
  const { uploadFile } = await import('../services/storage.js');
  const { key: savedKey } = await uploadFile(key, Buffer.from(await file.arrayBuffer()));

  db.insert(firmware).values({ id, version, deviceType, filePath: savedKey, fileSize: file.size, changelog }).run();
  return c.json({ ok: true, id });
});

app.get('/firmware', (c) => {
  return c.json({ firmware: db.select().from(firmware).all() });
});

export default app;
