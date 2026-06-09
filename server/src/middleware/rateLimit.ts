import { createMiddleware } from 'hono/factory';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function rateLimit(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > windowMs * 2) buckets.delete(key);
    }
  }, 300000);

  return createMiddleware(async (c, next) => {
    const key = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = { tokens: maxRequests, lastRefill: now };
      buckets.set(key, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed / windowMs) * maxRequests;
    if (refill > 0) {
      bucket.tokens = Math.min(maxRequests, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) {
      c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }

    bucket.tokens--;
    c.header('X-RateLimit-Remaining', String(bucket.tokens));
    await next();
  });
}
