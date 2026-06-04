import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { notes, aiTasks } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createTask } from '../services/queue.js';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

function ownNote(noteId: string, userId: string) {
  return db.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.userId, userId))).get();
}

app.get('/tasks/:noteId', (c) => {
  if (!ownNote(c.req.param('noteId'), c.var.user.id)) return c.json({ error: '笔记不存在' }, 404);
  const tasks = db.select().from(aiTasks).where(eq(aiTasks.noteId, c.req.param('noteId'))).all();
  return c.json({ tasks });
});

app.post('/summary/:noteId', (c) => {
  if (!ownNote(c.req.param('noteId'), c.var.user.id)) return c.json({ error: '笔记不存在' }, 404);
  createTask(c.req.param('noteId'), 'summary');
  return c.json({ ok: true });
});

app.post('/exam/:noteId', (c) => {
  if (!ownNote(c.req.param('noteId'), c.var.user.id)) return c.json({ error: '笔记不存在' }, 404);
  createTask(c.req.param('noteId'), 'exam_points');
  return c.json({ ok: true });
});

app.post('/mindmap/:noteId', (c) => {
  if (!ownNote(c.req.param('noteId'), c.var.user.id)) return c.json({ error: '笔记不存在' }, 404);
  createTask(c.req.param('noteId'), 'mind_map');
  return c.json({ ok: true });
});

export default app;
