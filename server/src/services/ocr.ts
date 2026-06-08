import { getEnv } from '../config.js';
import { readFileSync, existsSync } from 'fs';
import { getDownloadUrl } from './storage.js';

const OCR_MODEL = 'deepseek-ai/DeepSeek-OCR';

export async function recognize(imagePath: string): Promise<string> {
  const env = getEnv();

  // 用 SiliconFlow API key（和 ASR 共用）
  const apiKey = env.ASR_API_KEY;
  if (!apiKey) {
    console.log('[OCR] No API key configured');
    return '';
  }

  // 获取图片 base64 — 本地文件直接读，七牛云文件先下载
  let base64: string;
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    base64 = await fetchImageAsBase64(imagePath);
  } else if (imagePath.includes('/')) {
    // 可能是七牛云 key（如 images/xxx.jpg），生成签名 URL 再下载
    const url = getDownloadUrl(imagePath, { expiresIn: 300 });
    base64 = await fetchImageAsBase64(url);
  } else {
    // 纯文件名，尝试本地路径
    const localPath = `data/images/${imagePath}`;
    if (!existsSync(localPath)) {
      console.error(`[OCR] Image not found: ${localPath}`);
      return '';
    }
    base64 = readFileSync(localPath).toString('base64');
  }

  if (!base64) return '';

  try {
    const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64}`,
                detail: 'high',
              },
            },
            {
              type: 'text',
              text: '请识别图片中的所有文字，按从上到下、从左到右的顺序输出。只输出文字内容，不要添加任何解释。如果图片中没有文字，回复"无文字"。',
            },
          ],
        }],
        max_tokens: 2000,
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[OCR] API error:', res.status, errText);
      return '';
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    if (text === '无文字' || text === '无文字。') return '';
    console.log(`[OCR] Recognized ${text.length} chars: ${text.slice(0, 80)}...`);
    return text;
  } catch (e) {
    console.error('[OCR] Request failed:', (e as Error).message);
    return '';
  }
}

async function fetchImageAsBase64(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[OCR] Failed to fetch image: ${res.status}`);
      return '';
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } catch (e) {
    console.error('[OCR] Image fetch failed:', (e as Error).message);
    return '';
  }
}
