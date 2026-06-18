import { Hono } from 'hono';
import { getEnv } from '../config.js';
import { verifyDeviceUsername, verifyPersonalizedDevicePassword } from '../utils/deviceAuth.js';

const app = new Hono();

function authResult(allow: boolean, reason?: string) {
  return {
    result: allow ? 'allow' : 'deny',
    is_superuser: false,
    ...(reason ? { reason } : {}),
  };
}

app.post('/auth', async (c) => {
  const body: { username?: string; password?: string; clientid?: string } = await c.req
    .json<{ username?: string; password?: string; clientid?: string }>()
    .catch(() => ({}));
  const username = body.username || '';
  const password = body.password || '';
  const clientid = body.clientid || '';

  if (clientid === 'st_server') {
    const env = getEnv();
    const ok = username === env.MQTT_USER && password === env.MQTT_PASSWORD;
    return c.json(authResult(ok, ok ? undefined : 'invalid_server_credentials'));
  }

  if (verifyPersonalizedDevicePassword(username, password, clientid)) {
    return c.json(authResult(true));
  }

  const result = verifyDeviceUsername(username, clientid);
  return c.json(authResult(result.ok, result.ok ? undefined : result.reason));
});

export default app;
