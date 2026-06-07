import { getEnv } from '../config.js';
import { readFileSync } from 'fs';

export async function transcribe(audioPath: string, model?: string): Promise<string> {
  const env = getEnv();

  // MiMo ASR 模型走小米 API
  if (model && model.startsWith('mimo') && env.LLM_API_KEY && env.LLM_API_URL) {
    return transcribeMiMo(audioPath, model, env.LLM_API_KEY, env.LLM_API_URL);
  }

  // 硅基流动 API
  if (env.ASR_API_KEY) {
    return transcribeSiliconFlow(audioPath, env.ASR_API_KEY, model);
  }

  // 降级到本地 ASR 服务
  if (env.ASR_SERVICE_URL) {
    return transcribeLocal(audioPath, env.ASR_SERVICE_URL);
  }

  console.log('[ASR] No API key or service URL configured, returning placeholder');
  return '';
}

async function transcribeSiliconFlow(audioPath: string, apiKey: string, modelOverride?: string): Promise<string> {
  const url = 'https://api.siliconflow.cn/v1/audio/transcriptions';
  const wavBuffer = readFileSync(audioPath);
  const model = modelOverride || 'FunAudioLLM/SenseVoiceSmall';

  try {
    // 用 FormData 上传文件
    const form = new FormData();
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    form.append('file', blob, 'audio.wav');
    form.append('model', model);
    form.append('language', 'zh');
    form.append('response_format', 'json');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[ASR] SiliconFlow error:', res.status, errText);
      return '';
    }

    const data = await res.json() as { text?: string };
    const text = data.text || '';
    console.log(`[ASR] SiliconFlow transcribed ${wavBuffer.length} bytes -> ${text.length} chars`);
    return text;
  } catch (e: unknown) {
    console.error('[ASR] SiliconFlow request failed:', (e as Error).message);
    return '';
  }
}

async function transcribeLocal(audioPath: string, serviceUrl: string): Promise<string> {
  const wavBuffer = readFileSync(audioPath);

  try {
    const res = await fetch(`${serviceUrl}/asr`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    });

    if (!res.ok) {
      console.error('[ASR] Local service error:', res.status, await res.text());
      return '';
    }

    const data = await res.json() as { text: string };
    console.log(`[ASR] Local service transcribed ${wavBuffer.length} bytes -> ${data.text.length} chars`);
    return data.text;
  } catch (e: unknown) {
    console.error('[ASR] Local service failed:', (e as Error).message);
    return '';
  }
}

/**
 * MiMo ASR：通过 chat completions 接口，使用 input_audio 格式上传 WAV
 */
async function transcribeMiMo(audioPath: string, model: string, apiKey: string, apiUrl: string): Promise<string> {
  const wavBuffer = readFileSync(audioPath);
  const base64 = wavBuffer.toString('base64');

  // 用 /v1/chat/completions 替换原来的 /v1/chat/completions 路径
  const url = apiUrl.endsWith('/v1/chat/completions') ? apiUrl : apiUrl.replace(/\/$/, '') + '/v1/chat/completions';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${base64}`, format: 'wav' } }],
        }],
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[ASR] MiMo error:', res.status, errText);
      return '';
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || '';
    console.log(`[ASR] MiMo ${model} transcribed ${wavBuffer.length} bytes -> ${text.length} chars`);
    return text;
  } catch (e: unknown) {
    console.error('[ASR] MiMo request failed:', (e as Error).message);
    return '';
  }
}
