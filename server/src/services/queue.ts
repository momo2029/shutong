import { db, raw } from '../db/index.js';
import { aiTasks, notes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { transcribe } from './asr.js';
import { recognize } from './ocr.js';
import { generateSummary, generateExamPoints, generateMindMap } from './llm.js';

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
          db.update(notes).set({ rawTranscript: text }).where(eq(notes.id, note.id)).run();
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

setInterval(processQueue, 10000);
