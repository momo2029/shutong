import { Hono } from 'hono';
import { raw, db } from '../db/index.js';
import { notes, noteImages, devices, aiTasks } from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { snowflake } from '../utils/snowflake.js';
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
  const revisions = raw.prepare('SELECT * FROM revision_logs WHERE note_id = ? ORDER BY created_at ASC').all(c.req.param('id'));
  return c.json({ note, images, tasks, revisions });
});

app.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') || '';

  // JSON body: 无音频创建笔记（录音开始即创建，后续分块上传）
  if (contentType.includes('application/json')) {
    const body = await c.req.json() as { title?: string };
    const noteId = snowflake();
    const title = body.title || '网页录音笔记';
    const now = new Date().toISOString();
    db.insert(notes).values({ id: noteId, userId: c.var.user.id, title, status: 'processing', createdAt: now }).run();
    createTask(noteId, 'asr');
    return c.json({ ok: true, id: noteId });
  }

  // FormData: 完整音频上传（停止录音时）
  const form = await c.req.formData();
  const file = form.get('audio') as File | null;
  const title = form.get('title') as string || '网页录音笔记';
  const courseId = form.get('courseId') as string || null;
  const transcript = form.get('transcript') as string || '';
  if (!file) return c.json({ error: '未上传音频' }, 400);

  const noteId = snowflake();
  const key = `audio/${c.var.user.id}/${noteId}.webm`;
  const { uploadFile } = await import('../services/storage.js');
  const buffer = Buffer.from(await file.arrayBuffer());

  // 浏览器录音：本地保存一份供 ASR 使用（跳过空文件）
  const { mkdirSync } = await import('fs');
  const localAudioDir = `data/audio`;
  mkdirSync(localAudioDir, { recursive: true });
  const localPath = `data/audio/${noteId}.webm`;
  if (buffer.length > 0) {
    (await import('fs')).writeFileSync(localPath, buffer);
    uploadFile(key, buffer).catch(e => console.error('[Notes] Upload failed:', (e as Error).message));
  }
  const savedKey = buffer.length > 0 ? localPath : ''; // 空文件不设 audioPath

  const now = new Date().toISOString();
  // 有浏览器转录 → 写入但不重复创建 ASR 任务
  if (transcript.trim()) {
    db.insert(notes).values({
      id: noteId, userId: c.var.user.id, courseId, title, audioPath: savedKey,
      rawTranscript: transcript, status: 'processing', createdAt: now,
    }).run();
  } else {
    db.insert(notes).values({ id: noteId, userId: c.var.user.id, courseId, title, audioPath: savedKey, status: 'processing', createdAt: now }).run();
  }
  // ASR 任务（下游 summary/exam_points/mind_map 由 queue 在 ASR 完成后自动创建）
  createTask(noteId, 'asr');
  return c.json({ ok: true, id: noteId });
});

// 自动分块上传（每 1 分钟一段）
app.post('/:id/chunk', async (c) => {
  const noteId = c.req.param('id');
  const note = db.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const form = await c.req.formData();
  const file = form.get('audio') as File | null;
  const transcript = form.get('transcript') as string || '';
  const chunkIdx = parseInt(form.get('chunk') as string || '1');

  // 追加音频 chunk（保存到本地供后续完整 ASR）
  if (file) {
    const { appendFileSync, mkdirSync } = await import('fs');
    const chunkDir = `data/chunks/${noteId}`;
    mkdirSync(chunkDir, { recursive: true });
    const chunkPath = `${chunkDir}/chunk_${chunkIdx}.webm`;
    appendFileSync(chunkPath, Buffer.from(await file.arrayBuffer()));
  }

  // 更新转写文字（用最新的全量转录覆盖）
  if (transcript.trim()) {
    db.update(notes)
      .set({ rawTranscript: transcript, updatedAt: new Date().toISOString() })
      .where(eq(notes.id, noteId))
      .run();

    // 重新排队润色任务（只排队一次，不重复）
    const hasPendingPolish = db.select().from(aiTasks)
      .where(eq(aiTasks.noteId, noteId))
      .all()
      .some(t => t.taskType === 'asr' && (t.status === 'pending' || t.status === 'running'));
    if (!hasPendingPolish) {
      createTask(noteId, 'asr');
    }
  }

  return c.json({ ok: true, chunk: chunkIdx });
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

// 确认建议课程
app.post('/:id/confirm-course', async (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note || !note.suggestedCourseId) return c.json({ error: '无建议课程' }, 400);
  db.update(notes).set({ courseId: note.suggestedCourseId, suggestedCourseId: null, updatedAt: new Date().toISOString() }).where(eq(notes.id, c.req.param('id'))).run();
  return c.json({ ok: true });
});

// 忽略建议课程
app.post('/:id/dismiss-course', async (c) => {
  db.update(notes).set({ suggestedCourseId: null, updatedAt: new Date().toISOString() }).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).run();
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
