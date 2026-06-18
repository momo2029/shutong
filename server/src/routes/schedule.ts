import { Hono } from 'hono';
import { raw, db } from '../db/index.js';
import { scheduleSlots, courses } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { snowflake } from '../utils/snowflake.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Vars } from '../app.js';

const app = new Hono<{ Variables: Vars }>();

app.use('*', authMiddleware);

type SlotRow = {
  id: string; user_id: string; weekday: number; slot_index: number;
  start_time: string; end_time: string; course_id: string | null;
  classroom: string; teacher: string; course_name: string | null;
};

function slotsWithCourseName(userId: string) {
  return raw.prepare(`
    SELECT s.*, c.name AS course_name
    FROM schedule_slots s
    LEFT JOIN courses c ON c.id = s.course_id
    WHERE s.user_id = ?
    ORDER BY s.weekday, s.slot_index
  `).all(userId) as SlotRow[];
}

// 列出当前用户的所有 slots
app.get('/', (c) => {
  return c.json({ slots: slotsWithCourseName(c.var.user.id) });
});

// 批量保存整周课表（前端提交 slots 数组，删旧插新）
app.put('/', async (c) => {
  const body = await c.req.json() as {
    slots: Array<{
      weekday: number; slotIndex: number;
      startTime: string; endTime: string;
      courseId?: string | null;
      classroom?: string; teacher?: string;
    }>;
  };
  if (!Array.isArray(body.slots)) return c.json({ error: 'slots 必须是数组' }, 400);

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const cleaned: Array<{ weekday: number; slotIndex: number; startTime: string; endTime: string; courseId: string; classroom: string; teacher: string }> = [];
  for (const s of body.slots) {
    if (!s.courseId) continue; // 空课程跳过
    const weekday = Number(s.weekday);
    const slotIndex = Number(s.slotIndex);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return c.json({ error: `非法 weekday: ${s.weekday}` }, 400);
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > 30) {
      return c.json({ error: `非法 slotIndex: ${s.slotIndex}` }, 400);
    }
    if (!TIME_RE.test(s.startTime) || !TIME_RE.test(s.endTime)) {
      return c.json({ error: `非法时间格式: ${s.startTime}-${s.endTime}` }, 400);
    }
    if (s.startTime >= s.endTime) {
      return c.json({ error: '结束时间必须晚于开始时间' }, 400);
    }
    cleaned.push({
      weekday, slotIndex,
      startTime: s.startTime, endTime: s.endTime,
      courseId: String(s.courseId),
      classroom: String(s.classroom || '').slice(0, 50),
      teacher: String(s.teacher || '').slice(0, 50),
    });
  }

  const userId = c.var.user.id;
  const tx = raw.transaction(() => {
    raw.prepare(`DELETE FROM schedule_slots WHERE user_id = ?`).run(userId);
    const stmt = raw.prepare(`
      INSERT INTO schedule_slots (id, user_id, weekday, slot_index, start_time, end_time, course_id, classroom, teacher)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of cleaned) {
      stmt.run(snowflake(), userId, s.weekday, s.slotIndex, s.startTime, s.endTime,
        s.courseId, s.classroom, s.teacher);
    }
  });
  tx();
  return c.json({ ok: true, slots: slotsWithCourseName(userId) });
});

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export type CurrentSlotInfo = {
  weekday: number;
  current: any | null;
  next: any | null;
};

// 用 Asia/Shanghai 时区提取 weekday/hour/minute，避免服务器跑 UTC 时算错
const TZ = 'Asia/Shanghai';
export function todayWeekdayShanghai(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  const wd = fmt.format(now);
  const wdMap: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return wdMap[wd] ?? 1;
}
function toLocalFields(now: Date): { weekday: number; nowMin: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find(p => p.type === 'weekday')?.value || 'Mon';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const wdMap: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: wdMap[wd] ?? 1, nowMin: hour * 60 + minute };
}

export function computeCurrentSlot(userId: string, now: Date = new Date()): CurrentSlotInfo {
  const { weekday, nowMin } = toLocalFields(now);

  const rows = raw.prepare(`
    SELECT s.*, c.name AS course_name
    FROM schedule_slots s
    LEFT JOIN courses c ON c.id = s.course_id
    WHERE s.user_id = ? AND s.weekday = ?
    ORDER BY s.start_time
  `).all(userId, weekday) as SlotRow[];

  let current: any | null = null;
  let next: any | null = null;

  for (const s of rows) {
    const start = timeToMinutes(s.start_time);
    const end = timeToMinutes(s.end_time);
    if (nowMin >= start && nowMin < end) { current = s; }
    else if (nowMin < start && !next) { next = s; }
  }

  return {
    weekday,
    current: current ? { ...current, elapsedMin: nowMin - timeToMinutes(current.start_time) } : null,
    next: next ? { ...next, waitMin: timeToMinutes(next.start_time) - nowMin } : null,
  };
}

// 计算当前/下一节课
app.get('/current', (c) => {
  const nowParam = c.req.query('now');
  const now = nowParam ? new Date(nowParam) : new Date();
  return c.json(computeCurrentSlot(c.var.user.id, now));
});

export default app;
