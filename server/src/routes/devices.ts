import { Hono } from 'hono';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { snowflake } from '../utils/snowflake.js';
import { authMiddleware } from '../middleware/auth.js';
import { getDownloadUrl } from '../services/storage.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Vars } from '../app.js';

const VERSIONS_FILE = join(process.cwd(), 'data', 'firmware', 'versions.json');

function getLatestFirmwareUrl(): { url: string; version: string } | null {
  if (!existsSync(VERSIONS_FILE)) return null;
  try {
    const list = JSON.parse(readFileSync(VERSIONS_FILE, 'utf-8'));
    if (list.length === 0) return null;
    const latest = list[0];
    return { url: getDownloadUrl(latest.path, { expiresIn: 3600 }), version: latest.version };
  } catch { return null; }
}

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

app.get('/', (c) => {
  const list = db.select().from(devices).where(eq(devices.userId, c.var.user.id)).all();
  return c.json({ devices: list });
});

app.post('/bind', async (c) => {
  const body = await c.req.parseBody();
  const sn = (body.sn as string || '').trim();
  const name = body.name as string | undefined;
  if (!sn || sn.length < 4) return c.json({ error: '无效的设备序列号' }, 400);
  if (db.select().from(devices).where(eq(devices.sn, sn)).get()) return c.json({ error: '该设备已被绑定' }, 409);

  const id = snowflake();
  db.insert(devices).values({ id, sn, userId: c.var.user.id, name: name || `设备-${sn.slice(-6)}`, type: 'standard' }).run();
  return c.json({ ok: true, id });
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const dev = db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, c.var.user.id))).get();
  if (!dev) return c.json({ error: '设备不存在' }, 404);
  db.delete(devices).where(eq(devices.id, id)).run();
  return c.json({ ok: true });
});

app.post('/:id/cmd', async (c) => {
  const id = c.req.param('id');
  const { cmd, params } = await c.req.json<{ cmd: string; params?: Record<string, unknown> }>();
  const dev = db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, c.var.user.id))).get();
  if (!dev) return c.json({ error: '设备不存在' }, 404);
  if (!dev.online) return c.json({ error: '设备离线' }, 400);

  let finalParams = params || {};
  // OTA 命令：自动获取最新固件 URL
  if (cmd === 'ota') {
    const fw = getLatestFirmwareUrl();
    if (!fw) return c.json({ error: '没有可用固件，请先上传' }, 400);
    finalParams = { url: fw.url, version: fw.version };
    console.log(`[OTA] Pushing firmware ${fw.version} to device ${dev.sn}`);
  }

  const { publishCommand } = await import('../services/mqtt.js');
  await publishCommand(dev.sn, cmd, finalParams);
  return c.json({ ok: true, ...(cmd === 'ota' ? { version: (finalParams as any).version } : {}) });
});

export default app;
