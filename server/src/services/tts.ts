import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getEnv } from '../config.js';

function wavHeader(dataSize: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

export function pcmToWav(pcm: Buffer) {
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

export async function synthesizeSpeech(text: string) {
  const env = getEnv();
  if (!env.ASR_API_KEY) throw new Error('TTS API key not configured');

  const res = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ASR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.TTS_MODEL,
      input: text,
      response_format: 'wav',
      sample_rate: 16000,
    }),
  });

  if (!res.ok) throw new Error(`TTS API error: ${res.status}`);
  const wav = Buffer.from(await res.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'sht-tts-'));
  const inFile = join(dir, 'in.wav');
  const outFile = join(dir, 'out.pcm');
  try {
    writeFileSync(inFile, wav);
    execFileSync('ffmpeg', ['-y', '-i', inFile, '-f', 's16le', '-ar', '16000', '-ac', '1', outFile], { stdio: 'pipe' });
    return readFileSync(outFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
