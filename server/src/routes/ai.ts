import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { notes, aiTasks } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createTask } from '../services/queue.js';
import { transcribe } from '../services/asr.js';
import { join } from 'path';
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

// ─── ASR 模型对比测试（独立接口，不影响生产流程） ───
const ASR_MODELS = [
  { id: 'FunAudioLLM/SenseVoiceSmall',  name: 'SenseVoiceSmall' },
  { id: 'TeleAI/TeleSpeechASR',         name: 'TeleSpeechASR' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B', name: 'CosyVoice2-0.5B' },
  { id: 'mimo-v2.5-asr',               name: 'MiMo-v2.5-ASR' },
];

app.get('/compare-asr/:noteId', async (c) => {
  const note = ownNote(c.req.param('noteId'), c.var.user.id);
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  if (!note.audioPath) return c.json({ error: '笔记无音频' }, 400);

  const audioFile = join(process.cwd(), note.audioPath);

  const results: Record<string, { text: string; chars: number; ms: number }> = {};
  for (const m of ASR_MODELS) {
    const t0 = Date.now();
    try {
      const text = await transcribe(audioFile, m.id);
      results[m.name] = { text, chars: text.length, ms: Date.now() - t0 };
    } catch (e) {
      results[m.name] = { text: `ERROR: ${(e as Error).message}`, chars: 0, ms: Date.now() - t0 };
    }
  }

  return c.json({ noteId: note.id, title: note.title, results });
});

export default app;
