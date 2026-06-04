import { getEnv } from '../config.js';

export async function recognize(imagePath: string): Promise<string> {
  const env = getEnv();
  if (!env.OCR_API_KEY) {
    console.log('[OCR] No API key configured, returning placeholder');
    return '';
  }
  // TODO: integrate with 3rd-party OCR API
  return '';
}
