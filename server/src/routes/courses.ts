import { Hono } from 'hono';
import { db } from '../db/index.js';
import { courses } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

app.get('/', (c) => {
  const list = db.select().from(courses).where(eq(courses.userId, c.var.user.id)).all();
  return c.json({ courses: list });
});

app.get('/:id', (c) => {
  const course = db.select().from(courses).where(and(eq(courses.id, c.req.param('id')), eq(courses.userId, c.var.user.id))).get();
  if (!course) return c.json({ error: '课程不存在' }, 404);
  return c.json({ course });
});

app.post('/', async (c) => {
  const body = await c.req.parseBody();
  const name = (body.name as string || '').trim();
  const semester = body.semester as string | undefined;
  const description = body.description as string | undefined;
  if (!name) return c.json({ error: '课程名称不能为空' }, 400);
  const id = uuid();
  db.insert(courses).values({ id, userId: c.var.user.id, name, semester: semester || '', description: description || '' }).run();
  return c.json({ ok: true, id });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.parseBody();
  const name = (body.name as string || '').trim() || undefined;
  const semester = body.semester as string | undefined;
  const description = body.description as string | undefined;
  const course = db.select().from(courses).where(and(eq(courses.id, id), eq(courses.userId, c.var.user.id))).get();
  if (!course) return c.json({ error: '课程不存在' }, 404);
  db.update(courses).set({ name: name || course.name, semester: semester ?? course.semester, description: description ?? course.description }).where(eq(courses.id, id)).run();
  return c.json({ ok: true });
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!db.select().from(courses).where(and(eq(courses.id, id), eq(courses.userId, c.var.user.id))).get()) return c.json({ error: '课程不存在' }, 404);
  db.delete(courses).where(eq(courses.id, id)).run();
  return c.json({ ok: true });
});

export default app;
