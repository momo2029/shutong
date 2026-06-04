import { getEnv } from '../config.js';
import { readFileSync } from 'fs';

export async function transcribe(audioPath: string): Promise<string> {
  const env = getEnv();
  if (!env.ASR_SERVICE_URL) {
    console.log('[ASR] No ASR service URL configured, returning placeholder');
    return '';
  }

  // Read WAV file and send to ASR service
  const wavBuffer = readFileSync(audioPath);

  try {
    const res = await fetch(`${env.ASR_SERVICE_URL}/asr`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    });

    if (!res.ok) {
      console.error('[ASR] Service returned error:', res.status, await res.text());
      return '';
    }

    const data = await res.json() as { text: string };
    console.log(`[ASR] Transcribed ${wavBuffer.length} bytes -> ${data.text.length} chars`);
    return data.text;
  } catch (e: unknown) {
    console.error('[ASR] Failed to call ASR service:', (e as Error).message);
    return '';
  }
}
