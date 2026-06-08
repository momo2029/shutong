import { db, raw } from '../db/index.js';
import { aiTasks, notes, revisionLogs } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { snowflake } from '../utils/snowflake.js';
import { transcribe } from './asr.js';
import { recognize } from './ocr.js';
import { generateSummary, generateExamPoints, generateMindMap } from './llm.js';
import { execSync } from 'child_process';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { uploadFile } from './storage.js';
import { getEnv } from '../config.js';

function saveRevision(noteId: string, oldText: string, newText: string, stage: string) {
  if (!oldText || !newText) return;
  if (oldText === newText) return;
  const charsChanged = Math.abs(newText.length - oldText.length);
  // 长度变化 < 5 字且内容高度相似 → 跳过（微小修正不算一次修订）
  if (charsChanged < 5) return;
  db.insert(revisionLogs).values({
    id: snowflake(),
    noteId,
    oldText,
    newText,
    stage,
    charsChanged,
    createdAt: new Date().toISOString(),
  }).run();
  console.log(`[Queue] Revision log: ${stage}, ${charsChanged} chars changed`);
}

export type TaskType = 'asr' | 'ocr' | 'summary' | 'exam_points' | 'mind_map';

export function createTask(noteId: string, taskType: TaskType) {
  const existing = db.select().from(aiTasks)
    .where(and(eq(aiTasks.noteId, noteId), eq(aiTasks.taskType, taskType)))
    .all()
    .filter(t => t.status === 'pending' || t.status === 'running');
  if (existing.length > 0) return;
  return db.insert(aiTasks).values({
    id: snowflake(),
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
          const existing = note.rawTranscript || '';

          // 始终跑服务端 ASR（网页识别效果一般，服务端更准）
          let baseText = existing;

          // 合并所有音频分块（如果有的话）+ 主文件 → 转 WAV
          const { readdirSync } = await import('fs');
          const chunkDir = join(process.cwd(), 'data', 'chunks', note.id);
          const mainFile = note.audioPath ? join(process.cwd(), note.audioPath) : '';
          let audioFile = note.audioPath || '';

          // 检查是否有分块
          const hasChunks = existsSync(chunkDir) && readdirSync(chunkDir).filter(f => f.startsWith('chunk_')).length > 0;
          const stat = existsSync(mainFile) ? statSync(mainFile) : null;
          const hasMain = stat && stat.size > 0; // 跳过空文件（初始创建时可能为空）

          if (hasChunks || hasMain) {
            const wavFile = join(process.cwd(), 'data', 'audio', `${note.id}.wav`);
            try {
              if (hasChunks && hasMain) {
                // 有分块+主文件 → 逐块转 wav 后拼接
                const chunkFiles = readdirSync(chunkDir).filter(f => f.startsWith('chunk_')).sort();
                let concatList = '';
                let idx = 0;
                // 先加主文件
                if (note.audioPath.endsWith('.webm')) {
                  execSync(`ffmpeg -y -i "${mainFile}" -ar 16000 -ac 1 -sample_fmt s16 "/tmp/sht_main_${note.id}.wav"`, { stdio: 'pipe' });
                  concatList += `file '/tmp/sht_main_${note.id}.wav'\n`;
                } else {
                  concatList += `file '${mainFile}'\n`;
                }
                for (const cf of chunkFiles) {
                  const cp = join(chunkDir, cf);
                  execSync(`ffmpeg -y -i "${cp}" -ar 16000 -ac 1 -sample_fmt s16 "/tmp/sht_chunk_${note.id}_${idx}.wav"`, { stdio: 'pipe' });
                  concatList += `file '/tmp/sht_chunk_${note.id}_${idx}.wav'\n`;
                  idx++;
                }
                require('fs').writeFileSync(`/tmp/sht_concat_${note.id}.txt`, concatList);
                execSync(`ffmpeg -y -f concat -safe 0 -i "/tmp/sht_concat_${note.id}.txt" -c copy "${wavFile}"`, { stdio: 'pipe' });
                // 清理临时文件
                for (let i = 0; i < idx; i++) unlinkSync(`/tmp/sht_chunk_${note.id}_${i}.wav`);
                if (note.audioPath.endsWith('.webm')) unlinkSync(`/tmp/sht_main_${note.id}.wav`);
                unlinkSync(`/tmp/sht_concat_${note.id}.txt`);
              } else if (hasMain && note.audioPath.endsWith('.webm')) {
                execSync(`ffmpeg -y -i "${mainFile}" -ar 16000 -ac 1 -sample_fmt s16 "${wavFile}"`, { stdio: 'pipe' });
              } else if (hasChunks) {
                const chunkFiles = readdirSync(chunkDir).filter(f => f.startsWith('chunk_')).sort();
                let concatList = '';
                let idx = 0;
                for (const cf of chunkFiles) {
                  const cp = join(chunkDir, cf);
                  execSync(`ffmpeg -y -i "${cp}" -ar 16000 -ac 1 -sample_fmt s16 "/tmp/sht_chunk_${note.id}_${idx}.wav"`, { stdio: 'pipe' });
                  concatList += `file '/tmp/sht_chunk_${note.id}_${idx}.wav'\n`;
                  idx++;
                }
                require('fs').writeFileSync(`/tmp/sht_concat_${note.id}.txt`, concatList);
                execSync(`ffmpeg -y -f concat -safe 0 -i "/tmp/sht_concat_${note.id}.txt" -c copy "${wavFile}"`, { stdio: 'pipe' });
                for (let i = 0; i < idx; i++) unlinkSync(`/tmp/sht_chunk_${note.id}_${i}.wav`);
                unlinkSync(`/tmp/sht_concat_${note.id}.txt`);
              }
              audioFile = `data/audio/${note.id}.wav`;
              db.update(notes).set({ audioPath: audioFile }).where(eq(notes.id, note.id)).run();
              // 清理分块和原始 webm
              try { require('fs').rmSync(chunkDir, { recursive: true, force: true }); } catch(_) {}
              if (note.audioPath && note.audioPath.endsWith('.webm') && existsSync(mainFile)) unlinkSync(mainFile);
            } catch (e) {
              console.error('[Queue] Audio merge/conversion failed:', (e as Error).message);
              audioFile = note.audioPath || audioFile;
            }
          }

          const text = await transcribe(audioFile);
          if (text && text.length > existing.length * 0.8) {
            // 服务端 ASR 长度合理（不低于浏览器转写的 80%），使用服务端
            if (existing && existing.length > 20) {
              saveRevision(note.id, existing, text, 'asr');
            }
            baseText = text;
            console.log(`[Queue] Server ASR (${text.length} chars) replacing browser (${existing.length})`);
          } else if (text && !existing) {
            baseText = text;
          } else {
            console.log(`[Queue] Server ASR gave ${text?.length || 0} chars, keeping browser ${existing.length}`);
          }

          if (!baseText) break;

          // ── 分块渐进式润色：每 ~1800 字一段（约 3 分钟语音），逐段更新 ──
          const CHUNK_SIZE = 1800;
          const CHUNK_OVERLAP = 200;
          const chunks: string[] = [];
          let pos = 0;
          while (pos < baseText.length) {
            const end = Math.min(pos + CHUNK_SIZE, baseText.length);
            chunks.push(baseText.slice(pos, end));
            pos = end - (end < baseText.length ? CHUNK_OVERLAP : 0);
          }

          console.log(`[Queue] Polishing in ${chunks.length} chunks (~${Math.round(baseText.length / chunks.length)} chars each)`);

          let mergedResult = '';
          for (let i = 0; i < chunks.length; i++) {
            try {
              // 给 LLM 周围上下文
              const prevCtx = i > 0 ? mergedResult.slice(-300) : '';
              const nextCtx = i < chunks.length - 1 ? chunks[i + 1].slice(0, 300) : '';
              const ctxChunk = (prevCtx ? `上文：${prevCtx}\n\n` : '') + chunks[i] + (nextCtx ? `\n\n下文：${nextCtx}` : '');
              const polished = await polishChunk(ctxChunk, i + 1);

              if (polished) {
                if (i === 0) {
                  mergedResult = polished;
                } else {
                  // 拼接时去掉重叠部分
                  const overlapStart = mergedResult.length - CHUNK_OVERLAP;
                  if (overlapStart > 0) {
                    mergedResult = mergedResult.slice(0, overlapStart) + '\n' + polished;
                  } else {
                    mergedResult += '\n' + polished;
                  }
                }
                // 每完成一段就更新 DB，用户能看到逐段改善
                const prev = mergedResult;
                db.update(notes).set({ rawTranscript: mergedResult, updatedAt: new Date().toISOString() }).where(eq(notes.id, note.id)).run();
                saveRevision(note.id, prev, mergedResult, `polish_chunk_${i + 1}`);
                console.log(`[Queue] Chunk ${i + 1}/${chunks.length} polished (${mergedResult.length} chars total)`);
              }
            } catch (e) {
              console.error(`[Queue] Chunk ${i + 1} polish failed:`, (e as Error).message);
              mergedResult += chunks[i]; // fallback：直接用原文
            }
          }

          // 最终整体再过一遍润色（保证拼接处流畅）
          if (mergedResult.length > 500 && chunks.length > 1) {
            try {
              const final = await polishTranscript(mergedResult);
              if (final && final.length > mergedResult.length * 0.8) {
                saveRevision(note.id, mergedResult, final, 'polish_final');
                db.update(notes).set({ rawTranscript: final, updatedAt: new Date().toISOString() }).where(eq(notes.id, note.id)).run();
                console.log(`[Queue] Final polish: ${final.length} chars`);
              }
            } catch (e) {
              console.error('[Queue] Final polish failed:', (e as Error).message);
            }
          }

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

      updateTask(task.id, 'done');

      const remaining = db.select().from(aiTasks)
        .where(eq(aiTasks.noteId, note.id))
        .all()
        .filter(t => t.status === 'pending' || t.status === 'running');
      if (remaining.length === 0) {
        db.update(notes).set({ status: 'ready', updatedAt: new Date().toISOString() }).where(eq(notes.id, note.id)).run();
      }
    } catch (e: unknown) {
      updateTask(task.id, 'failed', (e as Error).message);
      db.update(notes).set({ status: 'failed' }).where(eq(notes.id, task.noteId)).run();
    }
  }
}

/**
 * 用 Qwen2.5（非推理模型）润色，强约束输出格式
 */
async function llmPolish(prompt: string, rawText: string, maxTokens: number): Promise<string> {
  const env = getEnv();
  if (!env.ASR_API_KEY) return rawText;

  const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.ASR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-7B-Instruct',  // 非推理模型，不输出分析
      messages: [
        { role: 'system', content: '你是语音转写纠错器。只输出修正后的纯文本，不要任何解释、标注、格式。' },
        { role: 'user', content: prompt + '\n\n原文：\n' + rawText },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    console.error('[Queue] Polish API error:', res.status);
    return rawText;
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = data.choices?.[0]?.message?.content;
  if (!result) return rawText;

  // 清洗：去掉常见的 LLM 废话前缀/后缀
  let cleaned = result
    .replace(/^[（(]*润色后[）)]*[：:]\s*/i, '')
    .replace(/^[（(]*修正后[）)]*[：:]\s*/i, '')
    .replace(/^[（(]*输出[）)]*[：:]\s*/i, '')
    .replace(/^\s*[「「](.*)[」」]\s*$/s, '$1')
    .trim();

  // 如果 LLM 返回了带「改写结果」「风格分析」等章节 → 只取纯文本部分
  if (cleaned.includes('改写结果') || cleaned.includes('风格分析') || cleaned.includes('**改写')) {
    // 提取「改写结果」或「**改写结果**」之后的内容
    const m = cleaned.match(/(?:改写结果|修正后文本)[：:\s]*\n?(?:[─\-—\-=]*\n)?([\s\S]*?)(?:改写说明|风格分析|注释|$)/i);
    if (m?.[1]) cleaned = m[1];
    // 去掉 markdown 标记
    cleaned = cleaned.replace(/\*\*/g, '').replace(/^[-─]+$/gm, '');
  }

  cleaned = cleaned.trim();
  if (cleaned.length < rawText.length * 0.5) return rawText; // 太短就丢弃，用原文

  console.log(`[Queue] Polish: ${rawText.length} → ${cleaned.length} chars`);
  return cleaned;
}

async function polishTranscript(rawText: string): Promise<string> {
  return llmPolish(
    '请修正以下语音识别文本的错别字、断句混乱、重复语句，补全不完整句子，添加适当标点。不要改变原意。',
    rawText, 4000
  );
}

async function polishChunk(chunk: string, seq: number): Promise<string> {
  return llmPolish(
    `请修正第${seq}段语音识别文本的错别字，理顺重复语句，补全不完整句子。`,
    chunk, 2000
  );
}

/**
 * 用 DeepSeek-R1（免费）根据摘要生成简短标题
 */
async function generateTitle(summary: string): Promise<string> {
  const env = getEnv();
  if (!env.ASR_API_KEY || !summary) return '';

  const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.ASR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages: [
        { role: 'system', content: '你只输出标题本身，10-20字。' },
        { role: 'user', content: '生成标题：' + summary },
      ],
      max_tokens: 50,
      temperature: 0.1,
    }),
  });

  if (!res.ok) return '';
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim().replace(/^["'「『《]|['"」』》]$/g, '').replace(/\*\*/g, '') || '';
}

setInterval(processQueue, 10000);
