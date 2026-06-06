// Safety net: prevent 3rd-party SDK async errors from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err.message);
});

import { serve } from '@hono/node-server';
import app from './app.js';
import { getEnv } from './config.js';
import { initMQTT } from './services/mqtt.js';

const env = getEnv();

// Mount API routes
const { default: auth } = await import('./routes/auth.js');
const { default: devices } = await import('./routes/devices.js');
const { default: courses } = await import('./routes/courses.js');
const { default: notes } = await import('./routes/notes.js');
const { default: upload } = await import('./routes/upload.js');
const { default: ai } = await import('./routes/ai.js');
const { default: exportRoutes } = await import('./routes/export.js');
const { default: admin } = await import('./routes/admin.js');
const { default: ota } = await import('./routes/ota.js');
const { default: knowledge } = await import('./routes/knowledge.js');

app.route('/api/auth', auth);
app.route('/api/devices', devices);
app.route('/api/courses', courses);
app.route('/api/notes', notes);
app.route('/api/upload', upload);
app.route('/api/ai', ai);
app.route('/api/export', exportRoutes);
app.route('/api/admin', admin);
app.route('/api/ota', ota);
app.route('/api/knowledge', knowledge);

// Init MQTT
initMQTT();

console.log(`Server starting on http://localhost:${env.PORT}`);
serve({ fetch: app.fetch, port: env.PORT });
