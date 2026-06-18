// Safety net: prevent 3rd-party SDK async errors from crashing the process
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', errorFields(reason));
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', errorFields(err));
});

import { serve } from '@hono/node-server';
import app from './app.js';
import { getEnv, validateProductionConfig } from './config.js';
import { initMQTT, isMqttConnected } from './services/mqtt.js';
import { rateLimit } from './middleware/rateLimit.js';
import { logger, errorFields } from './utils/logger.js';
import { raw } from './db/index.js';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const env = getEnv();
validateProductionConfig();

app.get('/health', (c) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {
    db: { ok: true },
    mqtt: { ok: true },
    disk: { ok: true },
  };

  try {
    raw.prepare('SELECT 1').get();
  } catch (e) {
    checks.db = { ok: false, error: (e as Error).message };
  }

  checks.mqtt.ok = isMqttConnected();
  if (!checks.mqtt.ok) checks.mqtt.error = 'not connected';

  try {
    const dir = join(process.cwd(), 'data');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '.healthcheck');
    writeFileSync(path, String(Date.now()));
    unlinkSync(path);
  } catch (e) {
    checks.disk = { ok: false, error: (e as Error).message };
  }

  const ok = Object.values(checks).every(check => check.ok);
  return c.json({ status: ok ? 'ok' : 'degraded', checks, uptime: process.uptime(), memory: process.memoryUsage() }, ok ? 200 : 503);
});

// Global rate limiting: 100 requests per minute per IP
app.use('/api/*', rateLimit(100, 60000));

// Mount API routes
const { default: auth } = await import('./routes/auth.js');
const { default: devices } = await import('./routes/devices.js');
const { default: courses } = await import('./routes/courses.js');
const { default: schedule } = await import('./routes/schedule.js');
const { default: notes } = await import('./routes/notes.js');
const { default: upload } = await import('./routes/upload.js');
const { default: ai } = await import('./routes/ai.js');
const { default: exportRoutes } = await import('./routes/export.js');
const { default: admin } = await import('./routes/admin.js');
const { default: ota } = await import('./routes/ota.js');
const { default: knowledge } = await import('./routes/knowledge.js');
const { default: mqttAuth } = await import('./routes/mqtt.js');

app.route('/api/auth', auth);
app.route('/api/devices', devices);
app.route('/api/courses', courses);
app.route('/api/schedule', schedule);
app.route('/api/notes', notes);
app.route('/api/upload', upload);
app.route('/api/ai', ai);
app.route('/api/export', exportRoutes);
app.route('/api/admin', admin);
app.route('/api/ota', ota);
app.route('/api/knowledge', knowledge);
app.route('/api/mqtt', mqttAuth);

logger.info('server starting', { port: env.PORT });
serve({ fetch: app.fetch, port: env.PORT });

// HTTP 服务先启动，避免 EMQX HTTP 认证回调时应用尚未监听。
initMQTT();
