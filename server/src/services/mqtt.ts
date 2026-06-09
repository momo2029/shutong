import mqtt from 'mqtt';
import { createHmac, timingSafeEqual } from 'crypto';
import { getEnv } from '../config.js';
import { raw, db } from '../db/index.js';
import { devices, notes, noteImages } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { snowflake } from '../utils/snowflake.js';
import { createTask } from './queue.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { uploadFile } from './storage.js';
import { transcribe } from './asr.js';
import { createShortLink } from './shortlink.js';

let client: mqtt.MqttClient | null = null;
const verifiedDeviceClientIds = new Set<string>();

// ── Audio chunk tracker: note_id → { total, count } (PCM data on disk) ──
const audioTrackers = new Map<string, { total: number; count: number; lastAsrSeq: number; asrBusy: boolean }>();

// 哪些笔记正在被用户查看（noteId → 最后查看时间）
const viewingNotes = new Map<string, number>();

const AUDIO_DIR = join(process.cwd(), 'data', 'audio');
const IMAGE_DIR = join(process.cwd(), 'data', 'images');
const CHUNKS_DIR = join(process.cwd(), 'data', 'chunks');
const DEVICE_USERNAME_SKEW_SECONDS = 300;
const DEVICE_RELATIVE_TIMESTAMP_MAX_SECONDS = 24 * 60 * 60;
const DEVICE_UNIX_TIMESTAMP_THRESHOLD_SECONDS = 1_000_000_000;

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 清理超过 2 小时的残留 chunk 缓冲（上次 crash 遗留） */
function cleanupStaleChunks() {
  if (!existsSync(CHUNKS_DIR)) return;
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 小时
  for (const entry of readdirSync(CHUNKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(CHUNKS_DIR, entry.name);
    try {
      const stat = require('fs').statSync(dirPath);
      if (now - stat.mtimeMs > maxAge) {
        rmSync(dirPath, { recursive: true, force: true });
        console.log(`[MQTT] Cleaned stale chunks: ${entry.name}`);
      }
    } catch { /* ignore */ }
  }
}

/**
 * 实时转写：取 [lastAsrSeq, count) 范围内的 PCM 做增量 ASR，追加到 rawTranscript。
 */
async function partialAsr(noteId: string) {
  const tracker = audioTrackers.get(noteId);
  if (!tracker) return;
  if (tracker.asrBusy) return; // 上一批还没转完，跳过
  tracker.asrBusy = true;

  const chunkDir = join(CHUNKS_DIR, noteId);
  if (!existsSync(chunkDir)) return;

  const startSeq = tracker.lastAsrSeq;
  const endSeq = tracker.count;
  const pcmBuffers: Buffer[] = [];

  for (let i = startSeq; i < endSeq; i++) {
    const chunkPath = join(chunkDir, `${i}.pcm`);
    if (existsSync(chunkPath)) {
      pcmBuffers.push(readFileSync(chunkPath));
    }
  }

  if (pcmBuffers.length === 0) return;

  console.log(`[MQTT] Partial ASR for note ${noteId}: seqs ${startSeq}-${endSeq - 1} (${pcmBuffers.length} chunks)`);

  // 合并 PCM 存为临时 WAV
  const dataSize = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  const wav = Buffer.concat([header, ...pcmBuffers]);
  const tmpWav = join(AUDIO_DIR, `${noteId}_partial.wav`);
  writeFileSync(tmpWav, wav);

  try {
    const text = await transcribe(`data/audio/${noteId}_partial.wav`);
    if (text) {
      const note = db.select().from(notes).where(eq(notes.id, noteId)).get();
      const prev = note?.rawTranscript || '';
      db.update(notes).set({ rawTranscript: prev + '\n' + text }).where(eq(notes.id, noteId)).run();
      console.log(`[MQTT] Partial ASR done: ${text.length} chars`);
    }
  } finally {
    if (existsSync(tmpWav)) unlinkSync(tmpWav);
    tracker.lastAsrSeq = endSeq;
    tracker.asrBusy = false;
  }
}

/**
 * 从磁盘缓冲目录读取 PCM 块，合并为 WAV 上传到七牛云，然后清理。
 */
async function finalizeAudio(noteId: string, totalChunks: number, deviceUserId: string, deviceId: string) {
  const tracker = audioTrackers.get(noteId);
  if (!tracker) return;
  audioTrackers.delete(noteId);

  const chunkDir = join(CHUNKS_DIR, noteId);
  const pcmBuffers: Buffer[] = [];
  if (existsSync(chunkDir)) {
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = join(chunkDir, `${i}.pcm`);
      if (existsSync(chunkPath)) {
        pcmBuffers.push(readFileSync(chunkPath));
      }
    }
  }

  if (pcmBuffers.length === 0) {
    console.log('[MQTT] No valid chunks, skipping');
    if (existsSync(chunkDir)) rmSync(chunkDir, { recursive: true, force: true });
    return;
  }

  const audioPath = buildWav(pcmBuffers, noteId);

  // 清理磁盘缓冲
  rmSync(chunkDir, { recursive: true, force: true });

  const existing = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!existing) {
    db.insert(notes).values({
      id: noteId,
      userId: deviceUserId,
      deviceId: deviceId,
      title: `课堂笔记 ${new Date().toLocaleDateString('zh-CN')}`,
      audioPath,
      status: 'processing',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
  } else {
    db.update(notes)
      .set({ audioPath, status: 'processing', updatedAt: new Date().toISOString() })
      .where(eq(notes.id, noteId))
      .run();
  }

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

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const wav = Buffer.concat([header, ...pcmBuffers]);
  const wavPath = join(AUDIO_DIR, `${noteId}.wav`);
  const relativeWavPath = `data/audio/${noteId}.wav`;
  writeFileSync(wavPath, wav);
  console.log(`[MQTT] WAV saved: ${wavPath} (${wav.length} bytes)`);
  return relativeWavPath;
}

export function initMQTT() {
  const env = getEnv();

  // 清理上次 crash 残留的 chunk 缓冲目录
  cleanupStaleChunks();

  // 清理上次异常停止遗留的 recording 状态
  const leftover = raw.prepare("UPDATE notes SET status = 'failed', updated_at = ? WHERE status = 'recording'").run(new Date().toISOString());
  if (leftover.changes > 0) console.log(`[MQTT] Marked ${leftover.changes} stale recording notes as failed`);

  if (!env.MQTT_BROKER) {
    console.log('[MQTT] No broker configured, skipping');
    return;
  }

  const opts: mqtt.IClientOptions = {
    clientId: 'sht_svr',
    clean: false,
  };
  if (env.MQTT_USER) {
    opts.username = env.MQTT_USER;
    opts.password = env.MQTT_PASSWORD;
  }
  client = mqtt.connect(env.MQTT_BROKER, opts);

  client.on('connect', () => {
    console.log('[MQTT] Connected to', env.MQTT_BROKER);
    client!.subscribe('$SYS/brokers/+/clients/+/connected');
    client!.subscribe('sht/+/status', { qos: 1 });
    client!.subscribe('sht/+/audio/chunk', { qos: 1 });
    client!.subscribe('sht/+/image', { qos: 1 });
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

  const masterKey = getEnv().DEVICE_MASTER_KEY;
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
  const apiUser = env.EMQX_API_USER;
  const apiPassword = env.EMQX_API_PASSWORD;

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
  const env = getEnv();
  if (env.EMQX_API_URL) {
    return env.EMQX_API_URL.replace(/\/$/, '');
  }

  try {
    const url = new URL(mqttBroker);
    const isTls = url.protocol === 'mqtts:';
    url.protocol = isTls ? 'https:' : 'http:';
    url.port = env.EMQX_API_PORT || (isTls ? '8083' : '18083');
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
      if (eos && noteId && audioTrackers.has(noteId)) {
        const tracker = audioTrackers.get(noteId)!;
        const actualTotal = tracker.count;
        console.log(`[MQTT] Audio EOS for note: ${noteId}, chunks=${actualTotal}`);
        await finalizeAudio(noteId, actualTotal, device.userId, device.id);
        break;
      }

      // 普通音频块
      if (!noteId || seq == null || !audioB64) {
        console.log('[MQTT] Invalid audio chunk, missing fields');
        break;
      }

      // 写入磁盘缓冲
      const chunkDir = join(CHUNKS_DIR, noteId);
      ensureDir(chunkDir);
      writeFileSync(join(chunkDir, `${seq}.pcm`), Buffer.from(audioB64, 'base64'));

      // 更新跟踪器
      if (!audioTrackers.has(noteId)) {
        audioTrackers.set(noteId, { total, count: 0, lastAsrSeq: 0, asrBusy: false });
        // 首次收到 chunk，创建笔记并标记"录制中"
        const existing = db.select().from(notes).where(eq(notes.id, noteId)).get();
        if (!existing) {
          db.insert(notes).values({
            id: noteId, userId: device.userId, deviceId: device.id,
            title: `课堂笔记 ${new Date().toLocaleDateString('zh-CN')}`,
            status: 'recording',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }).run();
          // 生成短链推送到设备 BLE 广播
          const noteUrl = `https://shutong.3198.net/r/${device.sn}?note=${noteId}`;
          createShortLink(noteUrl).then(shortUrl => {
            publishBleUrl(device.sn, shortUrl).catch(() => {});
          }).catch(() => {});
        } else if (existing.status !== 'recording') {
          db.update(notes).set({ status: 'recording', updatedAt: new Date().toISOString() }).where(eq(notes.id, noteId)).run();
        }
      }
      const tracker = audioTrackers.get(noteId)!;
      tracker.count++;

      // 根据是否有人在查看，动态调整实时转写间隔
      // 有人查看：每 10 秒（20 chunks）；无人查看：每 30 秒（60 chunks）
      const lastView = viewingNotes.get(noteId) || 0;
      const isBeingViewed = (Date.now() - lastView) < 15000;
      const asrInterval = isBeingViewed ? 10 : 60;
      if (tracker.count - tracker.lastAsrSeq >= asrInterval) {
        partialAsr(noteId).catch(e => console.error('[MQTT] Partial ASR failed:', (e as Error).message));
      }

      // total 已知且收齐 → 直接组装
      if (total > 0 && tracker.count >= total) {
        console.log(`[MQTT] Audio complete for note: ${noteId}`);
        await finalizeAudio(noteId, total, device.userId, device.id);
      } else {
        console.log(`[MQTT] Audio chunk ${seq + 1} for note ${noteId} (${tracker.count} received)`);
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

      const imgBuf = Buffer.from(imgB64, 'base64');

      // 上传到七牛云
      const key = `images/${noteId}_${Date.now()}.${format}`;
      try {
        const { key: imgKey } = await uploadFile(key, imgBuf);
        console.log(`[MQTT] Image uploaded: ${imgKey} (${imgBuf.length} bytes)`);

        // 确保 note 存在
        const existing = db.select().from(notes).where(eq(notes.id, noteId)).get();
        if (!existing) {
          db.insert(notes).values({
            id: noteId, userId: device.userId, deviceId: device.id,
            title: `课堂笔记 ${new Date().toLocaleDateString('zh-CN')}`,
            status: 'processing',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }).run();
        }

        // 写入 note_images 表
        const sortOrder = (db.select()
          .from(noteImages)
          .where(eq(noteImages.noteId, noteId))
          .all().length) || 0;
        db.insert(noteImages).values({
          id: snowflake(), noteId,
          imagePath: imgKey, sortOrder,
          createdAt: new Date().toISOString(),
        }).run();

        try { createTask(noteId, 'ocr'); } catch (_e) { /* ignore */ }
      } catch (e) {
        console.error('[MQTT] Failed to upload image:', (e as Error).message);
      }
      break;
    }
  }
}

async function createEmqxUser(username: string, password: string): Promise<boolean> {
  const env = getEnv();
  const apiBase = getEmqxApiBase(env.MQTT_BROKER);
  const url = `${apiBase}/api/v5/authentication/password_based:built_in_database/users`;
  const apiUser = env.EMQX_API_USER;
  const apiPassword = env.EMQX_API_PASSWORD;

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

  const masterKey = getEnv().DEVICE_MASTER_KEY;
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
    msg_id: snowflake(),
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
    msg_id: snowflake(),
    ts: Math.floor(Date.now() / 1000),
    type: 'cmd',
    payload: { cmd, params },
  };

  client.publish(`sht/${sn}/cmd`, JSON.stringify(msg), { qos: 1 });
}

/** 推送 BLE 广播短链接到设备 */
export async function publishBleUrl(sn: string, shortUrl: string) {
  if (!client) return;
  const msg = {
    msg_id: snowflake(),
    ts: Math.floor(Date.now() / 1000),
    type: 'ble_url',
    payload: { url: shortUrl },
  };
  client.publish(`sht/${sn}/cmd`, JSON.stringify(msg), { qos: 1 });
  console.log(`[MQTT] Pushed BLE URL to ${sn}: ${shortUrl}`);
}

export function isMqttConnected() {
  return !!client?.connected;
}

/** 标记笔记正在被用户查看（前端轮询调用） */
export function markNoteViewed(noteId: string) {
  viewingNotes.set(noteId, Date.now());
}

/** 定期清理超时的查看记录（超过 1 分钟没再查看的） */
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of viewingNotes) {
    if (now - ts > 60000) viewingNotes.delete(id);
  }
}, 60000);
