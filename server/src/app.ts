import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getEnv } from './config.js';

// Custom context variables
export type Vars = {
  user: { id: string; email: string; nickname: string; plan: string; storageUsed: number; storageLimit: number };
  render: (view: string, data?: Record<string, unknown>) => Response;
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
  const renderData = { ...data, env, user: (data as Record<string, unknown>).user || null };
  const body = ejs.render(viewTpl, renderData, { filename: viewPath });
  const layoutTpl = readFileSync(layoutPath, 'utf-8');
  return ejs.render(layoutTpl, { ...renderData, body }, { filename: layoutPath });
}

// Store render helper on context
app.use('*', async (c, next) => {
  c.set('render', (view: string, data: Record<string, unknown> = {}) => {
    const html = render(view, data);
    return c.html(html);
  });
  await next();
});

// Static files
app.use('/public/*', serveStatic({ root: '.' }));

// EJS page routes
app.get('/', (c) => c.var.render('dashboard/index.ejs', { title: '工作台' }));
app.get('/auth/login', (c) => c.var.render('auth/login.ejs', { title: '微信登录' }));
app.get('/auth/register', (c) => c.redirect('/auth/login'));
app.get('/auth/logout', (c) => {
  c.header('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0');
  return c.redirect('/auth/login');
});
app.get('/devices', (c) => c.var.render('devices/list.ejs', { title: '我的设备' }));
app.get('/devices/bind', (c) => c.var.render('devices/bind.ejs', { title: '绑定设备' }));
app.get('/courses', (c) => c.var.render('courses/list.ejs', { title: '课程' }));
app.get('/courses/new', (c) => c.var.render('courses/form.ejs', { title: '新建课程' }));
app.get('/courses/:id/edit', (c) => c.var.render('courses/form.ejs', { title: '编辑课程' }));
app.get('/notes', (c) => c.var.render('notes/list.ejs', { title: '笔记' }));
app.get('/notes/record', (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.redirect('/auth/login');
  return c.var.render('notes/record.ejs', { title: '录音' });
});
app.get('/notes/search', (c) => c.var.render('notes/search.ejs', { title: '搜索笔记' }));
app.get('/notes/:id', (c) => c.var.render('notes/detail.ejs', { title: '笔记详情' }));
app.get('/knowledge/ask', (c) => c.var.render('knowledge/ask.ejs', { title: '知识库问答' }));
app.get('/admin', (c) => c.var.render('admin/index.ejs', { title: '管理后台' }));
app.get('/admin/users', (c) => c.var.render('admin/users.ejs', { title: '用户管理' }));
app.get('/admin/firmware', (c) => c.var.render('admin/firmware.ejs', { title: '固件管理' }));

export default app;
