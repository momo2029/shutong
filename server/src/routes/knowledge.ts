import { Hono } from 'hono';
import { raw } from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { askKnowledge } from '../services/llm.js';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

app.get('/search', (c) => {
  const q = c.req.query('q') || '';
  if (!q) return c.json({ results: [] });
  const results = raw.prepare(
    `SELECT id, title, substr(raw_transcript, 0, 200) as snippet, status, created_at
     FROM notes WHERE user_id = ? AND raw_transcript LIKE ? ORDER BY created_at DESC LIMIT 20`
  ).all(c.var.user.id, `%${q}%`);
  return c.json({ results });
});

app.post('/ask', async (c) => {
  const { question } = await c.req.json<{ question: string }>();
  if (!question) return c.json({ error: '请输入问题' }, 400);

  const userNotes = raw.prepare(
    `SELECT title, raw_transcript, ai_summary FROM notes
     WHERE user_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 10`
  ).all(c.var.user.id) as Array<{ title: string; raw_transcript: string; ai_summary: string }>;

  const context = userNotes.map(n =>
    `【${n.title}】\n${n.ai_summary || n.raw_transcript.slice(0, 500)}`
  ).join('\n---\n');

  if (!context) return c.json({ answer: '你还没有已处理的笔记，请先录制课堂内容。' });
  const answer = await askKnowledge(question, context);
  return c.json({ answer: answer || 'AI暂时无法回答，请稍后再试。' });
});

export default app;
