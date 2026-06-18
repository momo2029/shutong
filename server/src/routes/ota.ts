import { Hono } from 'hono';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDownloadUrl, uploadFile } from '../services/storage.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Vars } from '../app.js';

const VERSIONS_FILE = join(process.cwd(), 'data', 'firmware', 'versions.json');
const FIRMWARE_PREFIX = 'firmware';

interface FirmwareEntry {
  version: string;
  path: string;
  size: number;
  uploadedAt: string;
}

function loadVersions(): FirmwareEntry[] {
  if (!existsSync(VERSIONS_FILE)) return [];
  try { return JSON.parse(readFileSync(VERSIONS_FILE, 'utf-8')); } catch { return []; }
}

function saveVersions(list: FirmwareEntry[]) {
  mkdirSync(join(process.cwd(), 'data', 'firmware'), { recursive: true });
  writeFileSync(VERSIONS_FILE, JSON.stringify(list, null, 2));
}

const MAX_FIRMWARE_SIZE = 4 * 1024 * 1024;

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);
app.use('*', async (c, next) => {
  if (c.var.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  await next();
});

app.get('/', (c) => {
  const list = loadVersions();
  const items = list.map(f => ({
    version: f.version,
    size: f.size,
    uploadedAt: f.uploadedAt,
    url: getDownloadUrl(f.path, { expiresIn: 3600 }),
  }));
  return c.json({ firmware: items });
});

app.post('/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file as File;
  if (!file) return c.json({ error: 'No file' }, 400);
  if (file.size <= 0 || file.size > MAX_FIRMWARE_SIZE) return c.json({ error: 'Invalid firmware size' }, 400);
  if (!file.name.endsWith('.bin')) return c.json({ error: 'Firmware must be a .bin file' }, 400);

  const version = body.version as string;
  if (!version || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z]+)?$/.test(version)) {
    return c.json({ error: 'valid version required' }, 400);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const key = `${FIRMWARE_PREFIX}/shutong-${version}.bin`;

  const result = await uploadFile(key, buf);
  if (!result) return c.json({ error: 'Upload failed' }, 500);

  const list = loadVersions();
  const idx = list.findIndex(f => f.version === version);
  const entry: FirmwareEntry = {
    version,
    path: key,
    size: buf.length,
    uploadedAt: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  list.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  saveVersions(list);

  return c.json({ ok: true, version, size: buf.length });
});

app.delete('/:version', (c) => {
  const version = c.req.param('version');
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z]+)?$/.test(version)) {
    return c.json({ error: 'invalid version' }, 400);
  }
  const list = loadVersions().filter(f => f.version !== version);
  saveVersions(list);
  return c.json({ ok: true });
});

export default app;
