/**
 * 短链服务 — hq8.net
 * 纯粹的长 URL → 短 URL，与设备/SN 无关
 */
const SHORTLINK_API = 'https://hq8.net/api/shorten';

// 内存缓存：长 URL → 短 URL（避免重复请求）
const cache = new Map<string, string>();

export async function createShortLink(url: string): Promise<string> {
  const cached = cache.get(url);
  if (cached) return cached;

  try {
    const resp = await fetch(SHORTLINK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!resp.ok) {
      console.error(`[shortlink] API error: ${resp.status}`);
      return url;
    }
    const data = (await resp.json()) as { short_url: string; short_code: string };
    const shortUrl = data.short_url;
    cache.set(url, shortUrl);
    console.log(`[shortlink] Created: ${shortUrl} → ${url}`);
    return shortUrl;
  } catch (e) {
    console.error('[shortlink] Request failed:', (e as Error).message);
    return url;
  }
}
