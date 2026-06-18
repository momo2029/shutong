import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getEnv } from './config.js';
import { db, raw } from './db/index.js';
import { users, courses, devices, notes, noteImages, scheduleSlots } from './db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { marked } from 'marked';
import { getMediaUrl } from './services/storage.js';
import { logger, errorFields } from './utils/logger.js';
import { randomUUID } from 'crypto';
import type { Context } from 'hono';

// Custom context variables
export type Vars = {
  user: { id: string; email: string; nickname: string; role: string; plan: string; storageUsed: number; storageLimit: number };
  render: (view: string, data?: Record<string, unknown>) => Promise<Response>;
  reqId: string;
};

const app = new Hono<{ Variables: Vars }>();

// EJS setup
const ejs = (await import('ejs')).default;
const { readFileSync } = await import('fs');
const { join, dirname } = await import('path');
const { fileURLToPath } = await import('url');
const __dirname = dirname(fileURLToPath(import.meta.url));

function render(view: string, data: Record<string, unknown> = {}) {
  const env = getEnv();
  const viewPath = join(__dirname, '..', 'views', view);
  const layoutPath = join(__dirname, '..', 'views', 'layout.ejs');
  const viewTpl = readFileSync(viewPath, 'utf-8');
  const renderData = { ...data, env, user: data.user || null, flash: data.flash || null };
  const body = ejs.render(viewTpl, renderData, { filename: viewPath });
  const layoutTpl = readFileSync(layoutPath, 'utf-8');
  return ejs.render(layoutTpl, { ...renderData, body }, { filename: layoutPath });
}

async function getUserFromCookie(cookie: string) {
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return null;

  try {
    const { verifyJWT } = await import('./utils/jwt.js');
    const payload = await verifyJWT(match[1]);
    const u = db.select().from(users).where(eq(users.id, payload.sub as string)).get();
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      role: u.role,
      plan: u.plan,
      storageUsed: u.storageUsed,
      storageLimit: u.storageLimit,
    };
  } catch (e) {
    logger.error('JWT verify failed', errorFields(e));
    return null;
  }
}

async function requirePageUser(c: Context<{ Variables: Vars }>) {
  const user = await getUserFromCookie(c.req.header('cookie') || '');
  if (!user) return null;
  c.set('user', user);
  return user;
}

async function renderAdminPage(c: Context<{ Variables: Vars }>, view: string, title: string) {
  const user = await requirePageUser(c);
  if (!user) return c.redirect('/auth/login');
  if (user.role !== 'admin') return c.redirect('/');
  return c.var.render(view, { title, user });
}

// Debug: add response header to verify deployment
app.use('*', async (c, next) => {
  await next();
  c.header('X-App-Version', '20260605-2');
});

// Request ID middleware + slow request warning
app.use('*', async (c, next) => {
  const reqId = randomUUID().slice(0, 8);
  c.set('reqId', reqId);
  c.header('X-Request-ID', reqId);
  const t0 = Date.now();
  await next();
  const elapsed = Date.now() - t0;
  if (elapsed > 1000) {
    logger.warn('slow request', { reqId, method: c.req.method, path: c.req.path, elapsed });
  }
});

// Store render helper on context, auto-inject user from JWT cookie
app.use('*', async (c, next) => {
  c.set('render', async (view: string, data: Record<string, unknown> = {}) => {
    const cookie = c.req.header('cookie') || '';
    if (!data.flash) {
      const flashMatch = cookie.match(/flash=([^;]+)/);
      if (flashMatch) {
        try { data.flash = JSON.parse(decodeURIComponent(flashMatch[1])); } catch (_) {}
        c.header('Set-Cookie', 'flash=; Path=/; Max-Age=0');
      }
    }
    if (!data.user) {
      const match = cookie.match(/token=([^;]+)/);
      if (match) {
        data.user = await getUserFromCookie(cookie);
      }
    }
    const html = render(view, data);
    return c.html(html);
  });
  await next();
});

// Static files
app.use('/public/*', serveStatic({ root: '.' }));
if (process.env.NODE_ENV !== 'production') {
  app.use('/data/*', serveStatic({ root: '.' }));
}

// EJS page routes
app.get('/', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  let currentSlot: any = null;
  let nextSlot: any = null;
  let weekday = new Date().getDay() === 0 ? 7 : new Date().getDay();
  if (match) {
    try {
      const { verifyJWT } = await import('./utils/jwt.js');
      const payload = await verifyJWT(match[1]);
      const { computeCurrentSlot } = await import('./routes/schedule.js');
      const info = computeCurrentSlot(payload.sub as string);
      currentSlot = info.current;
      nextSlot = info.next;
      weekday = info.weekday;
    } catch (e) { /* 未登录或无课表 */ }
  }
  return c.var.render('dashboard/index.ejs', { title: '工作台', currentSlot, nextSlot, weekday });
});
app.get('/auth/login', async (c) => c.var.render('auth/login.ejs', { title: '微信登录' }));
app.get('/auth/register', (c) => c.redirect('/auth/login'));
app.get('/auth/logout', (c) => {
  c.header('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0');
  return c.redirect('/auth/login');
});
app.get('/devices', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  let deviceList: any[] = [];
  if (match) {
    try {
      const { verifyJWT } = await import('./utils/jwt.js');
      const payload = await verifyJWT(match[1]);
      deviceList = db.select().from(devices).where(eq(devices.userId, payload.sub as string)).all();
    } catch (e) { /* fall through */ }
  }
  return c.var.render('devices/list.ejs', { title: '我的设备', devices: deviceList });
});
app.get('/devices/bind', async (c) => {
  const cookie = c.req.header('cookie') || '';
  if (!cookie.match(/token=([^;]+)/)) return c.redirect('/auth/login');
  return c.var.render('devices/bind.ejs', { title: '绑定设备' });
});
app.get('/devices/:id', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  try {
    const { verifyJWT } = await import('./utils/jwt.js');
    const payload = await verifyJWT(match[1]);
    const device = db.select().from(devices).where(and(eq(devices.id, c.req.param('id')), eq(devices.userId, payload.sub as string))).get();
    if (!device) return (await c.var.render('devices/list.ejs', { title: '我的设备', devices: [] }));
    const noteList = db.select().from(notes).where(eq(notes.deviceId, device.id)).orderBy(notes.createdAt).all();
    return c.var.render('devices/detail.ejs', { title: device.name, device, notes: noteList });
  } catch (e) { return c.redirect('/auth/login'); }
});
app.get('/courses', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  let courseList: Array<{ id: string; name: string; semester: string; description: string }> = [];
  if (match) {
    try {
      const { verifyJWT } = await import('./utils/jwt.js');
      const payload = await verifyJWT(match[1]);
      courseList = db.select().from(courses).where(eq(courses.userId, payload.sub as string)).all();
    } catch (e) { /* fall through */ }
  }
  return c.var.render('courses/list.ejs', { title: '课程', courses: courseList });
});
app.get('/courses/new', async (c) => {
  const cookie = c.req.header('cookie') || '';
  if (!cookie.match(/token=([^;]+)/)) return c.redirect('/auth/login');
  return c.var.render('courses/form.ejs', { title: '新建课程' });
});
app.get('/courses/:id/edit', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  try {
    const { verifyJWT } = await import('./utils/jwt.js');
    const payload = await verifyJWT(match[1]);
    const course = db.select().from(courses).where(and(eq(courses.id, c.req.param('id')), eq(courses.userId, payload.sub as string))).get();
    if (course) return c.var.render('courses/form.ejs', { title: '编辑课程', course });
  } catch (e) { /* fall through */ }
  return c.var.render('courses/form.ejs', { title: '编辑课程' });
});

// 课表页面
app.get('/schedule', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  let slots: any[] = [];
  let courseList: any[] = [];
  const { todayWeekdayShanghai, computeCurrentSlot } = await import('./routes/schedule.js');
  let currentInfo: any = { current: null, next: null, weekday: todayWeekdayShanghai() };
  if (match) {
    try {
      const { verifyJWT } = await import('./utils/jwt.js');
      const payload = await verifyJWT(match[1]);
      slots = raw.prepare(`
        SELECT s.*, c.name AS course_name
        FROM schedule_slots s
        LEFT JOIN courses c ON c.id = s.course_id
        WHERE s.user_id = ?
        ORDER BY s.weekday, s.slot_index
      `).all(payload.sub as string);
      courseList = db.select().from(courses).where(eq(courses.userId, payload.sub as string)).all();
      currentInfo = computeCurrentSlot(payload.sub as string);
    } catch (e) { /* fall through */ }
  }
  return c.var.render('schedule/index.ejs', { title: '课表', slots, courses: courseList, currentInfo, todayWeekday: currentInfo.weekday });
});

app.get('/schedule/edit', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  let slots: any[] = [];
  let courseList: any[] = [];
  const { todayWeekdayShanghai } = await import('./routes/schedule.js');
  const todayWeekday = todayWeekdayShanghai();
  try {
    const { verifyJWT } = await import('./utils/jwt.js');
    const payload = await verifyJWT(match[1]);
    slots = raw.prepare(`
      SELECT s.*, c.name AS course_name
      FROM schedule_slots s
      LEFT JOIN courses c ON c.id = s.course_id
      WHERE s.user_id = ?
      ORDER BY s.weekday, s.slot_index
    `).all(payload.sub as string);
    courseList = db.select().from(courses).where(eq(courses.userId, payload.sub as string)).all();
  } catch (e) { /* fall through */ }
  return c.var.render('schedule/edit.ejs', { title: '编辑课表', slots, courses: courseList, todayWeekday });
});

app.get('/notes', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  let noteList: any[] = [];
  let totalNotes = 0;
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const perPage = 15;
  if (match) {
    try {
      const { verifyJWT } = await import('./utils/jwt.js');
      const payload = await verifyJWT(match[1]);
      const all = db.select().from(notes).where(eq(notes.userId, payload.sub as string)).orderBy(desc(notes.createdAt)).all();
      totalNotes = all.length;
      noteList = all.slice((page - 1) * perPage, page * perPage);
    } catch (e) { /* fall through */ }
  }
  const totalPages = Math.ceil(totalNotes / perPage);
  return c.var.render('notes/list.ejs', { title: '笔记', notes: noteList, page, totalPages });
});
app.get('/notes/record', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  return c.var.render('notes/record.ejs', { title: '录音' });
});
app.get('/notes/record/:id', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  return c.var.render('notes/record.ejs', { title: '录音' });
});
app.get('/notes/search', async (c) => c.var.render('notes/search.ejs', { title: '搜索笔记' }));
app.get('/notes/:id', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  try {
    const { verifyJWT } = await import('./utils/jwt.js');
    const payload = await verifyJWT(match[1]);
    const note = db.select().from(notes).where(and(eq(notes.id, c.req.param('id')), eq(notes.userId, payload.sub as string))).get();
    if (!note) return (await c.var.render('notes/list.ejs', { title: '笔记', notes: [] }));
    const images = db.select().from(noteImages).where(eq(noteImages.noteId, note.id)).orderBy(noteImages.sortOrder).all();
    // 查询关联课程
    let courseName = '';
    let suggestedCourseName = '';
    if (note.courseId) {
      const course = db.select().from(courses).where(eq(courses.id, note.courseId)).get();
      courseName = course?.name || '';
    }
    if (note.suggestedCourseId) {
      const suggested = db.select().from(courses).where(eq(courses.id, note.suggestedCourseId)).get();
      suggestedCourseName = suggested?.name || '';
    }
    // 生成七牛云私有下载 URL（图片可选样式处理）
    const imageStyle = getEnv().QINIU_IMAGE_STYLE;
    const noteWithHtml = {
      ...note,
      audioPath: getMediaUrl(note.audioPath, { expiresIn: 86400 }), // 音频 24h
      aiSummaryHtml: note.aiSummary ? marked.parse(note.aiSummary) : '',
      examPointsHtml: note.examPoints ? marked.parse(note.examPoints) : '',
      mindMapHtml: note.mindMap ? marked.parse(note.mindMap) : '',
    };
    const imagesWithUrls = images.map(img => ({
      ...img,
      imagePath: getMediaUrl(img.imagePath, { style: imageStyle, expiresIn: 86400 }),
    }));
    return c.var.render('notes/detail.ejs', { title: note.title, note: noteWithHtml, images: imagesWithUrls, courseName, suggestedCourseName });
  } catch (e) { return c.redirect('/auth/login'); }
});

// 房间公开页 — /r/:sn（无需登录，用于 BLE/NFC 广播）
app.get('/r/:sn', async (c) => {
  const sn = c.req.param('sn');
  const device = db.select().from(devices).where(eq(devices.sn, sn)).get();
  if (!device) return c.var.render('room/not-found.ejs', { title: '房间未找到', sn });

  const noteId = c.req.query('note');
  let activeNote: any = null;
  if (noteId) {
    activeNote = db.select().from(notes).where(eq(notes.id, noteId)).get();
  }
  if (!activeNote) {
    // 取最近一条笔记
    const recent = db.select().from(notes).where(eq(notes.deviceId, device.id)).orderBy(desc(notes.createdAt)).limit(1).all();
    activeNote = recent.length > 0 ? recent[0] : null;
  }

  if (!activeNote) {
    return c.var.render('room/empty.ejs', { title: device.name || sn, sn, deviceName: device.name });
  }

  const images = db.select().from(noteImages).where(eq(noteImages.noteId, activeNote.id)).orderBy(noteImages.sortOrder).all();
  const imageStyle = getEnv().QINIU_IMAGE_STYLE;
  const noteWithHtml = {
    ...activeNote,
    audioPath: getMediaUrl(activeNote.audioPath, { expiresIn: 86400 }),
    aiSummaryHtml: activeNote.aiSummary ? marked.parse(activeNote.aiSummary) : '',
    examPointsHtml: activeNote.examPoints ? marked.parse(activeNote.examPoints) : '',
    mindMapHtml: activeNote.mindMap ? marked.parse(activeNote.mindMap) : '',
  };
  const imagesWithUrls = images.map(img => ({
    ...img,
    imagePath: getMediaUrl(img.imagePath, { style: imageStyle, expiresIn: 86400 }),
  }));

  return c.var.render('room/view.ejs', { title: activeNote.title, sn, deviceName: device.name, note: noteWithHtml, images: imagesWithUrls });
});
app.get('/knowledge/ask', async (c) => c.var.render('knowledge/ask.ejs', { title: '知识库问答' }));
app.get('/offline', async (c) => c.var.render('offline.ejs', { title: '离线' }));
app.get('/admin', async (c) => renderAdminPage(c, 'admin/index.ejs', '管理后台'));
app.get('/admin/users', async (c) => renderAdminPage(c, 'admin/users.ejs', '用户管理'));
app.get('/admin/firmware', async (c) => renderAdminPage(c, 'admin/firmware.ejs', '固件管理'));

export default app;
