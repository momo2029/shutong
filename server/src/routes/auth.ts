import { Hono } from 'hono';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { signJWT } from '../utils/jwt.js';

const WX_BASE = 'https://wx.3198.net';
const app = new Hono();

// POST /api/auth/wechat/qrcode — proxy to WeChat auth service
app.post('/wechat/qrcode', async (c) => {
  const form = new URLSearchParams();
  // Some endpoints accept different formats — try empty JSON POST
  const res = await fetch(`${WX_BASE}/auth/wechat/qrcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await res.json();
  return c.json(data);
});

// POST /api/auth/wechat/verify — proxy verify code, return JWT on success
app.post('/wechat/verify', async (c) => {
  const { sessionId, code } = await c.req.json<{ sessionId: string; code: string }>();

  if (!sessionId || !code) {
    return c.json({ error: '缺少 sessionId 或验证码' }, 400);
  }

  // Verify with WeChat auth service
  const res = await fetch(`${WX_BASE}/auth/wechat/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
  });
  const data = await res.json() as { openid?: string; error?: string };

  if (!data.openid) {
    return c.json({ error: data.error || '验证失败' }, 400);
  }

  // Find or create user by openid
  const email = `${data.openid}@wechat.local`;
  let user = db.select().from(users).where(eq(users.email, email)).get();

  if (!user) {
    const id = uuid();
    db.insert(users).values({
      id,
      email,
      passwordHash: '',
      nickname: `用户${data.openid.slice(-6)}`,
    }).run();
    user = db.select().from(users).where(eq(users.id, id)).get()!;
  }

  const token = await signJWT({ sub: user.id });
  c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
  return c.json({ ok: true });
});

// POST /api/auth/logout
app.post('/logout', (c) => {
  c.header('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0');
  return c.json({ ok: true });
});

// GET /api/auth/me
app.get('/me', async (c) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return c.json({ user: null });

  try {
    const { verifyJWT } = await import('../utils/jwt.js');
    const payload = await verifyJWT(match[1]);
    const u = db.select().from(users).where(eq(users.id, payload.sub as string)).get();
    if (!u) return c.json({ user: null });
    return c.json({ user: { id: u.id, email: u.email, nickname: u.nickname, plan: u.plan } });
  } catch {
    return c.json({ user: null });
  }
});

export default app;
