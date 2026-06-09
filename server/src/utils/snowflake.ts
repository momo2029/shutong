// 雪花 ID 生成器（单进程，无需 worker 位）
const EPOCH = 1704067200000n; // 2024-01-01T00:00:00.000Z
let lastTimestamp = 0n;
let sequence = 0n;

export function snowflake(): string {
  let now = BigInt(Date.now());
  if (now === lastTimestamp) {
    sequence++;
    if (sequence >= 4096n) {
      // 序列号溢出，等下一毫秒
      while (now <= lastTimestamp) now = BigInt(Date.now());
      sequence = 0n;
    }
  } else {
    sequence = 0n;
  }
  lastTimestamp = now;

  const ts = now - EPOCH;
  // 时间戳 42 位 + 序列号 12 位 = 54 位
  const id = (ts << 12n) | (sequence & 0xFFFn);
  return id.toString(16);
}
