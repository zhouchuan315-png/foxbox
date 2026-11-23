import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * ULID 风格 ID：10 位时间 + 16 位随机，共 26 字符。
 * 字典序即时间序，方便直接用于 ORDER BY，无需额外索引列。
 */
export function newId(now = Date.now()): string {
  const time = encodeTime(now, 10);
  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += CROCKFORD[bytes[i]! % 32]!;
  }
  return time + random;
}

export function nowMs(): number {
  return Date.now();
}
