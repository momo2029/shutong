import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { notes } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

app.get('/note/:id/pdf', (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${note.title}</title>
<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;line-height:1.8;}h1{color:#4f46e5;}h2{color:#1e293b;margin-top:24px;}pre{white-space:pre-wrap;background:#f8fafc;padding:16px;border-radius:8px;}</style></head><body>
<h1>${note.title}</h1><p>${note.createdAt}</p>
<h2>课堂文稿</h2><pre>${note.rawTranscript || '暂无'}</pre>
<h2>AI 摘要</h2><pre>${note.aiSummary || '暂无'}</pre>
<h2>考试重点</h2><pre>${note.examPoints || '暂无'}</pre>
<h2>思维导图</h2><pre>${note.mindMap || '暂无'}</pre>
</body></html>`;
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${note.title}.html"`);
  return c.html(html);
});

app.get('/note/:id/docx', (c) => {
  const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, c.var.user.id))).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${note.title}</title></head>
<body><h1>${note.title}</h1>
<h2>课堂文稿</h2><pre>${note.rawTranscript || '暂无'}</pre>
<h2>AI 摘要</h2><pre>${note.aiSummary || '暂无'}</pre>
<h2>考试重点</h2><pre>${note.examPoints || '暂无'}</pre>
</body></html>`;
  c.header('Content-Type', 'application/msword');
  c.header('Content-Disposition', `attachment; filename="${note.title}.doc"`);
  return c.html(html);
});

export default app;
