import { Hono } from 'hono';
import { db } from '../db/index.js';
import { notes, noteImages } from '../db/schema.js';
import { snowflake } from '../utils/snowflake.js';
import { authMiddleware } from '../middleware/auth.js';
import { uploadFile, getMediaUrl } from '../services/storage.js';
import { eq, and } from 'drizzle-orm';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

app.post('/audio', async (c) => {
  const form = await c.req.formData();
  const file = form.get('audio') as File | null;
  const title = form.get('title') as string || '网页录音笔记';
  if (!file) return c.json({ error: '未上传音频文件' }, 400);

  const noteId = snowflake();
  const key = `audio/${c.var.user.id}/${noteId}.webm`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const { key: savedKey } = await uploadFile(key, buffer);

  db.insert(notes).values({ id: noteId, userId: c.var.user.id, title, audioPath: savedKey, status: 'processing', createdAt: new Date().toISOString() }).run();
  return c.json({ ok: true, id: noteId });
});

app.post('/image', async (c) => {
  const form = await c.req.formData();
  const file = form.get('image') as File | null;
  const noteId = form.get('noteId') as string;
  if (!file) return c.json({ error: '未上传图片' }, 400);
  if (!noteId) return c.json({ error: '缺少 noteId' }, 400);

  const note = db.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const imageId = snowflake();
  const key = `images/${c.var.user.id}/${noteId}/${imageId}.jpg`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const { key: savedKey } = await uploadFile(key, buffer);

  db.insert(noteImages).values({ id: imageId, noteId, imagePath: savedKey, sortOrder: 0 }).run();
  return c.json({ ok: true, id: imageId, url: getMediaUrl(savedKey) });
});

export default app;
