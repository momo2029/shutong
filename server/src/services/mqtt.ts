import mqtt from 'mqtt';
import { createHmac, timingSafeEqual } from 'crypto';
import { getEnv } from '../config.js';
import { db } from '../db/index.js';
import { devices, notes, noteImages } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { createTask } from './queue.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

let client: mqtt.MqttClient | null = null;
const verifiedDeviceClientIds = new Set<string>();

// ── Audio chunk buffer: note_id → { total, chunks: Map<seq, base64> } ──
const audioBuffers = new Map<string, { total: number; chunks: Map<number, string> }>();

const AUDIO_DIR = join(process.cwd(), 'data', 'audio');
const IMAGE_DIR = join(process.cwd(), 'data', 'images');
const DEVICE_USERNAME_SKEW_SECONDS = 300;
const DEVICE_RELATIVE_TIMESTAMP_MAX_SECONDS = 24 * 60 * 60;
const DEVICE_UNIX_TIMESTAMP_THRESHOLD_SECONDS = 1_000_000_000;

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Assemble audio chunks and finalize the note.
 */
function finalizeAudio(noteId: string, totalChunks: number, deviceUserId: string, deviceId: string) {
  const buf = audioBuffers.get(noteId);
  if (!buf) return;
  audioBuffers.delete(noteId);

  // Build WAV from ordered chunks
  const pcmBuffers: Buffer[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const b64 = buf.chunks.get(i);
    if (b64) {
      pcmBuffers.push(Buffer.from(b64, 'base64'));
    }
  }

  if (pcmBuffers.length === 0) {
    console.log('[MQTT] No valid chunks, skipping');
    return;
  }

  const wavPath = buildWav(pcmBuffers, noteId);
  const existing = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!existing) {
    db.insert(notes).values({
      id: noteId,
      userId: deviceUserId,
      deviceId: deviceId,
      title: `课堂笔记 ${new Date().toLocaleDateString('zh-CN')}`,
      audioPath: wavPath,
      status: 'processing',
    }).run();
  } else {
    db.update(notes)
      .set({ audioPath: wavPath, status: 'processing' })
      .where(eq(notes.id, noteId))
      .run();
  }

  // Trigger ASR task
  createTask(noteId, 'asr');
}

/**
 * Build a WAV file from raw 16-bit mono PCM data at 16kHz.
 * Returns the file path.
 */
function buildWav(pcmBuffers: Buffer[], noteId: string): string {
  ensureDir(AUDIO_DIR);
  const dataSize = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // WAV header: 44 bytes
  const header = Buffer.alloc(44);
  // RIFF chunk descriptor
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4); // file size - 8
  header.write('WAVE', 8);
  // fmt sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // subchunk size (PCM)
  header.writeUInt16LE(1, 20);         // audio format (PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  // data sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const wav = Buffer.concat([header, ...pcmBuffers]);
  const wavPath = join(AUDIO_DIR, `${noteId}.wav`);
  writeFileSync(wavPath, wav);
  console.log(`[MQTT] WAV saved: ${wavPath} (${wav.length} bytes)`);
  return wavPath;
}

export function initMQTT() {
  const env = getEnv();
  if (!env.MQTT_BROKER) {
    console.log('[MQTT] No broker configured, skipping');
    return;
  }

  const opts: mqtt.IClientOptions = {
    clientId: 'sht_svr',
    clean: true,
  };
  if (env.MQTT_USER) {
    opts.username = env.MQTT_USER;
    opts.password = env.MQTT_PASSWORD;
  }
  client = mqtt.connect(env.MQTT_BROKER, opts);

  client.on('connect', () => {
    console.log('[MQTT] Connected to', env.MQTT_BROKER);
    client!.subscribe('$SYS/brokers/+/clients/+/connected');
    client!.subscribe('sht/+/status');
    client!.subscribe('sht/+/audio/chunk');
    client!.subscribe('sht/+/image');
  });

  client.on('message', (topic, message) => {
    try {
      if (isClientConnectedTopic(topic)) {
        const data = JSON.parse(message.toString()) as Record<string, unknown>;
        handleClientConnected(data);
        return;
      }

      const sn = topic.split('/')[1];
      const type = topic.split('/').slice(2).join('/');
      const data = JSON.parse(message.toString());
      handleMessage(sn, type, data);
    } catch {
      console.log('[MQTT] Invalid message on', topic);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
  });
}

function isClientConnectedTopic(topic: string): boolean {
  // EMQX publishes to: $SYS/brokers/{node}/clients/{clientid}/connected
  const parts = topic.split('/');
  return parts.length === 6
    && parts[0] === '$SYS'
    && parts[1] === 'brokers'
    && parts[3] === 'clients'
    && parts[5] === 'connected';
}

async function handleClientConnected(data: Record<string, unknown>) {
  const clientid = typeof data.clientid === 'string' ? data.clientid : '';
  const username = typeof data.username === 'string' ? data.username : undefined;

  if (!clientid) {
    console.log('[MQTT] Client connected event missing clientid');
    return;
  }

  if (clientid === 'sht_svr') {
    return;
  }

  const result = verifyDeviceUsername(username, clientid);
  if (result.ok) {
    verifiedDeviceClientIds.add(clientid);
    console.log(`[MQTT] Device username verified: ${clientid}, type=${result.type}`);

    // If using default credentials, send personalized credentials
    if (result.type === 'fixed' && username === 'st_device') {
      const sn = clientid.startsWith('st_') ? clientid.substring(3) : clientid;
      sendPersonalizedCredentials(sn).catch(err => {
        console.error(`[MQTT] Failed to send credentials to ${sn}:`, err);
      });
    }
    return;
  }

  verifiedDeviceClientIds.delete(clientid);
  console.log(`[MQTT] Device username verification failed: ${clientid}, reason=${result.reason}`);
  const disconnectResult = await disconnectClient(clientid);
  if (!disconnectResult.ok) {
    console.warn(`[MQTT] Unauthorized client may remain connected: ${clientid}, reason=${disconnectResult.reason}`);
  }
}

function verifyDeviceUsername(username: string | undefined, clientid: string): { ok: true; type: string } | { ok: false; reason: string } {
  if (!username) {
    return { ok: false, reason: 'missing_username' };
  }

  // Support fixed username format: st_device or st_{SN}
  if (username === 'st_device' || username.startsWith('st_')) {
    return { ok: true, type: 'fixed' };
  }

  // Dynamic authentication format: type:timestamp:signature
  const parts = username.split(':');
  if (parts.length !== 3) {
    return { ok: false, reason: 'invalid_username_format' };
  }

  const [type, timestampText, signature] = parts;
  if (!type || !timestampText || !signature) {
    return { ok: false, reason: 'invalid_username_format' };
  }

  const timestamp = Number(timestampText);
  if (!Number.isInteger(timestamp)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (timestamp < 0) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  if (timestamp < DEVICE_UNIX_TIMESTAMP_THRESHOLD_SECONDS) {
    if (timestamp > DEVICE_RELATIVE_TIMESTAMP_MAX_SECONDS) {
      return { ok: false, reason: 'relative_timestamp_out_of_range' };
    }
  } else {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > DEVICE_USERNAME_SKEW_SECONDS) {
      return { ok: false, reason: 'timestamp_out_of_range' };
    }
  }

  const masterKey = process.env.DEVICE_MASTER_KEY || '';
  if (!masterKey) {
    return { ok: false, reason: 'missing_device_master_key' };
  }

  const sn = clientid.startsWith('st_') ? clientid.substring(3) : clientid;
  const payload = `${type}|${timestampText}|${sn}`;
  const expected = createHmac('sha256', masterKey)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true, type };
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

async function disconnectClient(clientid: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = getEnv();
  const apiBase = getEmqxApiBase(env.MQTT_BROKER);
  const url = `${apiBase}/api/v5/clients/${encodeURIComponent(clientid)}`;
  const apiUser = process.env.EMQX_API_USER || process.env.EMQX_API_KEY || '';
  const apiPassword = process.env.EMQX_API_PASSWORD || process.env.EMQX_API_SECRET || '';

  if (!apiUser || !apiPassword) {
    console.warn('[MQTT] Cannot disconnect client via EMQX API: missing EMQX_API_USER/PASSWORD or EMQX_API_KEY/SECRET');
    return { ok: false, reason: 'missing_emqx_api_credentials' };
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${apiUser}:${apiPassword}`).toString('base64')}`,
  };

  try {
    const response = await fetch(url, { method: 'DELETE', headers });
    if (response.ok || response.status === 404) {
      console.log(`[MQTT] Disconnected client via EMQX API: ${clientid}, status=${response.status}`);
      return { ok: true };
    }

    const body = await response.text().catch(() => '');
    console.warn(
      `[MQTT] Failed to disconnect client via EMQX API: ${clientid}, status=${response.status}, statusText=${response.statusText}, body=${body}`,
    );
    return { ok: false, reason: `emqx_api_status_${response.status}` };
  } catch (err) {
    console.error('[MQTT] EMQX API disconnect error:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'emqx_api_request_failed' };
  }
}

function getEmqxApiBase(mqttBroker: string): string {
  if (process.env.EMQX_API_URL) {
    return process.env.EMQX_API_URL.replace(/\/$/, '');
  }

  try {
    const url = new URL(mqttBroker);
    const isTls = url.protocol === 'mqtts:';
    url.protocol = isTls ? 'https:' : 'http:';
    url.port = process.env.EMQX_API_PORT || (isTls ? '8083' : '18083');
    url.username = '';
    url.password = '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'http://127.0.0.1:18083';
  }
}

async function handleMessage(sn: string, type: string, data: Record<string, unknown>) {
  const expectedClientid = `st_${sn}`;

  // Auto-verify: if device exists in database, trust it
  if (!verifiedDeviceClientIds.has(expectedClientid)) {
    const dev = db.select().from(devices).where(eq(devices.sn, sn)).get();
    if (dev) {
      verifiedDeviceClientIds.add(expectedClientid);
      console.log(`[MQTT] Device auto-verified: ${expectedClientid}`);
    } else {
      console.log(`[MQTT] Unknown device, ignoring: sn=${sn}`);
      return;
    }
  }

  const device = db.select().from(devices).where(eq(devices.sn, sn)).get()!;
  if (!device) {
    console.log('[MQTT] Unknown device:', sn);
    return;
  }

  switch (type) {
    case 'status': {
      const p = data.payload as Record<string, unknown> | undefined;
      const status = p?.status as string;
      db.update(devices)
        .set({
          online: status === 'online' ? 1 : 0,
          lastSeen: new Date().toISOString(),
          firmwareVersion: (p?.fw_ver as string) || device.firmwareVersion,
        })
        .where(eq(devices.sn, sn))
        .run();
      break;
    }

    case 'audio/chunk': {
      const p = data.payload as Record<string, unknown>;
      const noteId = p.note_id as string;
      const seq = p.seq as number;
      const total = p.total as number;
      const audioB64 = p.data as string;
      const eos = p.eos as boolean | undefined;

      // EOS 消息：无音频数据，仅标记结束
      if (eos && noteId && audioBuffers.has(noteId)) {
        const buf = audioBuffers.get(noteId)!;
        const actualTotal = buf.chunks.size;
        console.log(`[MQTT] Audio EOS for note: ${noteId}, chunks=${actualTotal}`);
        finalizeAudio(noteId, actualTotal, device.userId, device.id);
        break;
      }

      // 普通音频块
      if (!noteId || seq == null || !audioB64) {
        console.log('[MQTT] Invalid audio chunk, missing fields');
        break;
      }

      // Init buffer for this note
      if (!audioBuffers.has(noteId)) {
        audioBuffers.set(noteId, { total, chunks: new Map() });
      }
      const buf = audioBuffers.get(noteId)!;
      buf.chunks.set(seq, audioB64);

      // 旧模式：total 已知且收齐 → 直接组装
      if (total > 0 && buf.chunks.size >= total) {
        console.log(`[MQTT] Audio complete for note: ${noteId}`);
        finalizeAudio(noteId, total, device.userId, device.id);
      } else {
        console.log(`[MQTT] Audio chunk ${seq + 1} for note ${noteId} (${buf.chunks.size} received)`);
      }
      break;
    }

    case 'image': {
      const p = data.payload as Record<string, unknown>;
      const noteId = (p.note_id as string);
      const imgB64 = p.data as string;
      const format = (p.format as string) || 'jpeg';

      if (!noteId || !imgB64) {
        console.log('[MQTT] Invalid image, missing note_id or data');
        break;
      }

      ensureDir(IMAGE_DIR);
      const imgPath = join(IMAGE_DIR, `${noteId}_${Date.now()}.${format}`);
      const imgBuf = Buffer.from(imgB64, 'base64');
      writeFileSync(imgPath, imgBuf);
      console.log(`[MQTT] Image saved: ${imgPath} (${imgBuf.length} bytes)`);

      // 写入 note_images 表
      const sortOrder = (db.select()
        .from(noteImages)
        .where(eq(noteImages.noteId, noteId))
        .all().length) || 0;
      db.insert(noteImages).values({
        id: uuid(),
        noteId,
        imagePath: imgPath,
        sortOrder,
      }).run();

      // 触发 OCR（API key 未设置时静默跳过）
      try { createTask(noteId, 'ocr'); } catch (_e) { /* ignore */ }
      break;
    }
  }
}

async function createEmqxUser(username: string, password: string): Promise<boolean> {
  const env = getEnv();
  const apiBase = getEmqxApiBase(env.MQTT_BROKER);
  const url = `${apiBase}/api/v5/authentication/password_based:built_in_database/users`;
  const apiUser = process.env.EMQX_API_USER || process.env.EMQX_API_KEY || '';
  const apiPassword = process.env.EMQX_API_PASSWORD || process.env.EMQX_API_SECRET || '';

  if (!apiUser || !apiPassword) {
    console.warn('[MQTT] Cannot create EMQX user: missing API credentials');
    return false;
  }

  const headers: Record<string, string> = {
    'Authorization': `Basic ${Buffer.from(`${apiUser}:${apiPassword}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: username, password }),
    });

    if (response.ok || response.status === 409) {
      console.log(`[MQTT] EMQX user created or already exists: ${username}`);
      return true;
    }

    const body = await response.text().catch(() => '');
    console.warn(`[MQTT] Failed to create EMQX user: ${username}, status=${response.status}, body=${body}`);
    return false;
  } catch (err) {
    console.error('[MQTT] EMQX API create user error:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function sendPersonalizedCredentials(sn: string) {
  if (!client) throw new Error('MQTT not connected');

  const masterKey = process.env.DEVICE_MASTER_KEY;
  if (!masterKey) {
    console.error('[MQTT] DEVICE_MASTER_KEY not set, cannot issue credentials');
    return;
  }

  const username = `st_${sn}`;
  const password = createHmac('sha256', masterKey)
    .update(sn)
    .digest('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 32);

  // Create user in EMQX first
  const created = await createEmqxUser(username, password);
  if (!created) {
    console.error(`[MQTT] Failed to create EMQX user for ${sn}`);
    return;
  }

  const msg = {
    msg_id: uuid(),
    ts: Math.floor(Date.now() / 1000),
    type: 'update_credentials',
    username,
    password,
  };

  client.publish(`sht/${sn}/cmd`, JSON.stringify(msg), { qos: 1 });
  console.log(`[MQTT] Sent personalized credentials to device ${sn}`);
}

export async function publishCommand(sn: string, cmd: string, params: Record<string, unknown>) {
  if (!client) throw new Error('MQTT not connected');

  const msg = {
    msg_id: uuid(),
    ts: Math.floor(Date.now() / 1000),
    type: 'cmd',
    payload: { cmd, params },
  };

  client.publish(`sht/${sn}/cmd`, JSON.stringify(msg), { qos: 1 });
}
