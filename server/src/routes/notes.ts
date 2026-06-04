import { Hono } from 'hono';
import { raw, db } from '../db/index.js';
import { notes, noteImages } from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { createTask } from '../services/queue.js';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

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
  const { url } = await uploadFile(key, buffer);

  db.insert(notes).values({ id: noteId, userId: c.var.user.id, courseId, title, audioPath: url, status: 'processing' }).run();
  createTask(noteId, 'asr');
  return c.json({ ok: true, id: noteId });
});

app.delete('/:id', (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);
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

export default app;
