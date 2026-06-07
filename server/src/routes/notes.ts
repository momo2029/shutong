import { Hono } from 'hono';
import { raw, db } from '../db/index.js';
import { notes, noteImages, devices } from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { createTask } from '../services/queue.js';
import { markNoteViewed, publishCommand } from '../services/mqtt.js';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

// 前端轮询：标记正在查看某条笔记（控制实时转写频率）
app.post('/:id/viewing', (c) => {
  markNoteViewed(c.req.param('id'));
  return c.json({ ok: true });
});

// 停止录音（向设备发送 stop_record 命令）
app.post('/:id/stop-recording', async (c) => {
  const note = db.select().from(notes).where(eq(notes.id, c.req.param('id'))).get();
  if (!note || !note.deviceId) return c.json({ error: '笔记无关联设备' }, 400);

  const device = db.select().from(devices).where(eq(devices.id, note.deviceId)).get();
  if (!device) return c.json({ error: '设备不存在' }, 404);

  try {
    await publishCommand(device.sn, 'stop_record', {});
  } catch (e) {
    return c.json({ error: 'MQTT 未连接' }, 503);
  }

  db.update(notes).set({ status: 'paused', updatedAt: new Date().toISOString() }).where(eq(notes.id, note.id)).run();
  return c.json({ ok: true });
});

// 继续录音（向设备发送 start_record 命令）
app.post('/:id/resume-recording', async (c) => {
  const note = db.select().from(notes).where(eq(notes.id, c.req.param('id'))).get();
  if (!note || !note.deviceId) return c.json({ error: '笔记无关联设备' }, 400);

  const device = db.select().from(devices).where(eq(devices.id, note.deviceId)).get();
  if (!device) return c.json({ error: '设备不存在' }, 404);

  try {
    await publishCommand(device.sn, 'start_record', {});
  } catch (e) {
    return c.json({ error: 'MQTT 未连接' }, 503);
  }

  return c.json({ ok: true, note: '设备将创建新笔记继续录音' });
});

// 设备拍照（向设备发送 capture 命令）
app.post('/:id/capture', async (c) => {
  const note = db.select().from(notes).where(eq(notes.id, c.req.param('id'))).get();
  if (!note || !note.deviceId) return c.json({ error: '笔记无关联设备' }, 400);

  const device = db.select().from(devices).where(eq(devices.id, note.deviceId)).get();
  if (!device) return c.json({ error: '设备不存在' }, 404);

  try {
    await publishCommand(device.sn, 'capture', {});
  } catch (e) {
    return c.json({ error: 'MQTT 未连接' }, 503);
  }

  return c.json({ ok: true, message: '拍照指令已发送' });
});

app.get('/', (c) => {
  const userId = c.var.user.id;
  const courseId = c.req.query('course');
  const status = c.req.query('status');
  const q = c.req.query('q');
  const page = parseInt(c.req.query('page') || '1');

  const conds = [eq(notes.userId, userId)];
  if (courseId) conds.push(eq(notes.courseId, courseId));
  if (status) conds.push(eq(notes.status, status));
  if (q) conds.push(like(notes.rawTranscript, `%${q}%`));

  const all = db.select().from(notes).where(and(...conds)).all().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = 20;
  const paged = all.slice((page - 1) * limit, page * limit);
  return c.json({ notes: paged, total: all.length, page });
});

app.get('/:id', (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const images = db.select().from(noteImages).where(eq(noteImages.noteId, c.req.param('id'))).all();
  const tasks = raw.prepare('SELECT * FROM ai_tasks WHERE note_id = ?').all(c.req.param('id'));
  return c.json({ note, images, tasks });
});

app.post('/', async (c) => {
  const form = await c.req.formData();
  const file = form.get('audio') as File | null;
  const title = form.get('title') as string || '网页录音笔记';
  const courseId = form.get('courseId') as string || null;
  if (!file) return c.json({ error: '未上传音频' }, 400);

  const noteId = uuid();
  const key = `audio/${c.var.user.id}/${noteId}.webm`;
  const { uploadFile } = await import('../services/storage.js');
  const buffer = Buffer.from(await file.arrayBuffer());
  const { key: savedKey } = await uploadFile(key, buffer);

  db.insert(notes).values({ id: noteId, userId: c.var.user.id, courseId, title, audioPath: savedKey, status: 'processing' }).run();
  createTask(noteId, 'asr');
  return c.json({ ok: true, id: noteId });
});

app.delete('/:id', async (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  // 删除关联的本地文件（音频 + 照片 + 缓冲）
  const { unlinkSync, existsSync, rmSync } = await import('fs');
  const { join } = await import('path');

  if (note.audioPath) {
    // 本地路径才删除（七牛云 URL 跳过）
    if (!note.audioPath.startsWith('http')) {
      const audio = join(process.cwd(), note.audioPath);
      if (existsSync(audio)) unlinkSync(audio);
    }
  }

  const images = db.select().from(noteImages).where(eq(noteImages.noteId, note.id)).all();
  for (const img of images) {
    if (!img.imagePath.startsWith('http')) {
      const ipath = join(process.cwd(), img.imagePath);
      if (existsSync(ipath)) unlinkSync(ipath);
    }
  }

  // 清理可能残留的 chunk 缓冲目录
  const chunkDir = join(process.cwd(), 'data', 'chunks', c.req.param('id'));
  if (existsSync(chunkDir)) rmSync(chunkDir, { recursive: true, force: true });

  db.delete(notes).where(eq(notes.id, c.req.param('id'))).run();
  return c.json({ ok: true });
});

app.post('/:id/reprocess', (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  db.update(notes).set({ status: 'processing' }).where(eq(notes.id, c.req.param('id'))).run();
  createTask(c.req.param('id'), 'asr');
  return c.json({ ok: true });
});

// 关联课程
app.put('/:id/course', async (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const body = await c.req.parseBody();
  const courseId = (body.courseId as string) || null;
  db.update(notes).set({ courseId, updatedAt: new Date().toISOString() }).where(eq(notes.id, c.req.param('id'))).run();
  return c.json({ ok: true });
});

export default app;
