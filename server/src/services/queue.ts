import { db, raw } from '../db/index.js';
import { aiTasks, notes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { transcribe } from './asr.js';
import { recognize } from './ocr.js';
import { generateSummary, generateExamPoints, generateMindMap } from './llm.js';
import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { uploadFile } from './storage.js';
import { getEnv } from '../config.js';

export type TaskType = 'asr' | 'ocr' | 'summary' | 'exam_points' | 'mind_map';

export function createTask(noteId: string, taskType: TaskType) {
  return db.insert(aiTasks).values({
    id: uuid(),
    noteId,
    taskType,
    status: 'pending',
  }).run();
}

export function getTasks(noteId: string) {
  return db.select().from(aiTasks).where(eq(aiTasks.noteId, noteId)).all();
}

function updateTask(id: string, status: string, errorMsg = '') {
  db.update(aiTasks)
    .set({ status, errorMsg, updatedAt: new Date().toISOString() })
    .where(eq(aiTasks.id, id))
    .run();
}

export async function processQueue() {
  const tasks = db.select().from(aiTasks).where(eq(aiTasks.status, 'pending')).all();
  for (const task of tasks) {
    updateTask(task.id, 'running');
    try {
      const note = db.select().from(notes).where(eq(notes.id, task.noteId)).get();
      if (!note) { updateTask(task.id, 'failed', 'Note not found'); continue; }

      switch (task.taskType) {
        case 'asr': {
          const text = await transcribe(note.audioPath);

          // DeepSeek-R1 润色 ASR 转写（硅基流动免费模型）
          let polishedText = text;
          if (text) {
            try {
              polishedText = await polishTranscript(text);
            } catch (e) {
              console.error('[Queue] Polish failed, using raw ASR:', (e as Error).message);
            }
          }

          db.update(notes).set({ rawTranscript: polishedText }).where(eq(notes.id, note.id)).run();

          // 压缩 WAV → Opus 并上传到七牛云，释放本地空间
          try {
            const wavAbs = join(process.cwd(), note.audioPath);
            if (existsSync(wavAbs)) {
              const opusPath = wavAbs.replace('.wav', '.opus');
              // 去除 >10s 静音段 → 响度归一化 → Opus 24kbps
              execSync(`ffmpeg -y -i "${wavAbs}" -af "silenceremove=stop_periods=-1:stop_duration=10:stop_threshold=-35dB,loudnorm=I=-16:TP=-1.5:LRA=11" -c:a libopus -b:a 24k -ar 16000 -ac 1 "${opusPath}"`, { stdio: 'pipe' });
              const opusKey = `audio/${note.id}.opus`;
              const { key: savedKey } = await uploadFile(opusKey, require('fs').readFileSync(opusPath));
              db.update(notes).set({ audioPath: savedKey }).where(eq(notes.id, note.id)).run();
              console.log(`[Queue] Audio compressed & uploaded: ${savedKey}`);
              // 清理本地文件
              unlinkSync(wavAbs);
              unlinkSync(opusPath);
            }
          } catch (e) {
            console.error('[Queue] Failed to compress/upload audio:', (e as Error).message);
            // 不阻塞后续流程，WAV 保留在本地
          }

          createTask(note.id, 'summary');
          createTask(note.id, 'exam_points');
          createTask(note.id, 'mind_map');
          break;
        }
        case 'ocr': {
          const imgs = raw.prepare('SELECT image_path FROM note_images WHERE note_id = ?').all(note.id) as Array<{ image_path: string }>;
          for (const img of imgs) {
            const text = await recognize(img.image_path);
            raw.prepare('UPDATE note_images SET ocr_text = ? WHERE image_path = ?').run(text, img.image_path);
          }
          break;
        }
        case 'summary': {
          if (!note.rawTranscript) break;
          const summary = await generateSummary(note.rawTranscript);
          db.update(notes).set({ aiSummary: summary }).where(eq(notes.id, note.id)).run();

          // 用摘要自动生成标题（免费 DeepSeek-R1）
          if (summary && note.title.startsWith('课堂笔记')) {
            try {
              const newTitle = await generateTitle(summary);
              if (newTitle) {
                db.update(notes).set({ title: newTitle, updatedAt: new Date().toISOString() }).where(eq(notes.id, note.id)).run();
                console.log(`[Queue] Title generated: ${newTitle}`);
              }
            } catch (e) { /* 标题生成失败不影响主流程 */ }
          }
          break;
        }
        case 'exam_points': {
          if (!note.rawTranscript) break;
          const points = await generateExamPoints(note.rawTranscript);
          db.update(notes).set({ examPoints: points }).where(eq(notes.id, note.id)).run();
          break;
        }
        case 'mind_map': {
          if (!note.rawTranscript) break;
          const map = await generateMindMap(note.rawTranscript);
          db.update(notes).set({ mindMap: map }).where(eq(notes.id, note.id)).run();
          break;
        }
      }

      const remaining = db.select().from(aiTasks)
        .where(eq(aiTasks.noteId, note.id))
        .all()
        .filter(t => t.status === 'pending' || t.status === 'running');
      if (remaining.length === 0) {
        db.update(notes).set({ status: 'ready' }).where(eq(notes.id, note.id)).run();
      }

      updateTask(task.id, 'done');
    } catch (e: unknown) {
      updateTask(task.id, 'failed', (e as Error).message);
      db.update(notes).set({ status: 'failed' }).where(eq(notes.id, task.noteId)).run();
    }
  }
}

/**
 * 用 DeepSeek-R1（硅基流动免费）润色 ASR 转写文本
 */
async function polishTranscript(rawText: string): Promise<string> {
  const env = getEnv();
  if (!env.ASR_API_KEY) return rawText; // 无硅基流动 key 则跳过

  const prompt = `你是一个中文语音转写纠错助手。以下是通过语音识别得到的中文文本，存在同音错字、断句混乱等问题。请修正错别字、合并重复、补全残缺句子、添加适当标点，使其通顺易读。不要改变原意、不要添加原文没有的内容。直接输出润色后的文本。

原文：
${rawText}`;

  const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.ASR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    console.error('[Queue] Polish API error:', res.status, await res.text());
    return rawText;
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const polished = data.choices?.[0]?.message?.content;
  if (polished) {
    console.log(`[Queue] Polish: ${rawText.length} → ${polished.length} chars`);
    return polished;
  }
  return rawText;
}

/**
 * 用 DeepSeek-R1（免费）根据摘要生成简短标题
 */
async function generateTitle(summary: string): Promise<string> {
  const env = getEnv();
  if (!env.ASR_API_KEY || !summary) return '';

  const prompt = `根据以下课堂笔记摘要，生成一个简短的标题（10-20字），直接输出标题，不要加任何说明。

摘要：
${summary}`;

  const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.ASR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
    }),
  });

  if (!res.ok) return '';
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim().replace(/^["'「『《]|['"」』》]$/g, '') || '';
}

setInterval(processQueue, 10000);
