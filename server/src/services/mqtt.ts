import mqtt from 'mqtt';
import { getEnv } from '../config.js';
import { db } from '../db/index.js';
import { devices, notes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { createTask } from './queue.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

let client: mqtt.MqttClient | null = null;

// ── Audio chunk buffer: note_id → { total, chunks: Map<seq, base64> } ──
const audioBuffers = new Map<string, { total: number; chunks: Map<number, string> }>();

const AUDIO_DIR = join(process.cwd(), 'data', 'audio');

function ensureAudioDir() {
  if (!existsSync(AUDIO_DIR)) {
    mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

/**
 * Build a WAV file from raw 16-bit mono PCM data at 16kHz.
 * Returns the file path.
 */
function buildWav(pcmBuffers: Buffer[], noteId: string): string {
  ensureAudioDir();
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

  client = mqtt.connect(env.MQTT_BROKER, {
    clientId: 'sht_svr',
    clean: true,
    username: 'sht_svr',
    password: env.MQTT_PASSWORD || 'shutong_mqtt_pass',
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to', env.MQTT_BROKER);
    client!.subscribe('sht/+/status');
    client!.subscribe('sht/+/audio/chunk');
    client!.subscribe('sht/+/image');
  });

  client.on('message', (topic, message) => {
    try {
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

async function handleMessage(sn: string, type: string, data: Record<string, unknown>) {
  const device = db.select().from(devices).where(eq(devices.sn, sn)).get();
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

      if (!noteId || seq == null || total == null || !audioB64) {
        console.log('[MQTT] Invalid audio chunk, missing fields');
        break;
      }

      // Init buffer for this note
      if (!audioBuffers.has(noteId)) {
        audioBuffers.set(noteId, { total, chunks: new Map() });
      }
      const buf = audioBuffers.get(noteId)!;
      buf.chunks.set(seq, audioB64);

      console.log(`[MQTT] Audio chunk ${seq + 1}/${total} for note ${noteId} (${buf.chunks.size}/${total} received)`);

      // Check if all chunks received
      if (buf.chunks.size >= total) {
        console.log(`[MQTT] Audio complete for note: ${noteId}`);
        audioBuffers.delete(noteId);

        // Build WAV from ordered chunks
        const pcmBuffers: Buffer[] = [];
        for (let i = 0; i < total; i++) {
          const b64 = buf.chunks.get(i);
          if (b64) {
            pcmBuffers.push(Buffer.from(b64, 'base64'));
          }
        }

        if (pcmBuffers.length === 0) {
          console.log('[MQTT] No valid chunks, skipping');
          break;
        }

        const wavPath = buildWav(pcmBuffers, noteId);

        // Create or update note record
        const existing = db.select().from(notes).where(eq(notes.id, noteId)).get();
        if (!existing) {
          db.insert(notes).values({
            id: noteId,
            userId: device.userId,
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
      break;
    }

    case 'image': {
      const p = data.payload as Record<string, unknown>;
      const noteId = (p.note_id as string) || uuid();
      console.log('[MQTT] Image received for note:', noteId);
      // Store image + trigger OCR — implemented in M4
      break;
    }
  }
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
