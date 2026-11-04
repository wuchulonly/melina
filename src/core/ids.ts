// Id、Handle、SnapshotId。Id 是 ULID：26 位 Crockford base32，前 10 位是毫秒时间，按时间有序。

import { createHash, randomFillSync } from 'node:crypto';

export type Id = string;
/** Artifact store 里一个对象的引用：art://<sha256> */
export type Handle = `art://${string}`;
/** snapshot 的 id 由 WorkspaceProvider 定；'root' 表示本 Run 的根 snapshot，不建记录 */
export type SnapshotId = string;

export const ROOT = 'root';
export const ID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';
export const HANDLE_PATTERN = '^art://[0-9a-f]{64}$';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_RE = new RegExp(ID_PATTERN);
const HANDLE_RE = new RegExp(HANDLE_PATTERN);

export interface IdSource {
  /** 当前毫秒时间，默认 Date.now */
  now?: () => number;
  /** 填随机字节，默认 crypto.randomFillSync；测试和假剧本传固定种子的版本 */
  random?: (bytes: Uint8Array) => void;
}

/**
 * 建一个单调的 ULID 生成器：同一毫秒里连续生成的 id 也严格递增，
 * 所以同一个进程里按 id 排序就是按生成顺序排序。
 */
export function createIdGenerator(source: IdSource = {}): () => Id {
  const now = source.now ?? Date.now;
  const random = source.random ?? ((bytes: Uint8Array) => randomFillSync(bytes));
  let lastTime = -1;
  const lastRandom = new Uint8Array(10);
  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      if (!increment(lastRandom)) {
        time = lastTime + 1;
        random(lastRandom);
      }
    } else {
      random(lastRandom);
    }
    lastTime = time;
    return encodeTime(time) + encodeRandom(lastRandom);
  };
}

/** 进程里默认的 id 生成器 */
export const newId: () => Id = createIdGenerator();

export function isId(value: unknown): value is Id {
  return typeof value === 'string' && ID_RE.test(value);
}

/** ULID 里的毫秒时间 */
export function idTime(id: Id): number {
  let time = 0;
  for (const ch of id.slice(0, 10)) {
    const v = ENCODING.indexOf(ch);
    if (v < 0) throw new Error(`不是 ULID：${id}`);
    time = time * 32 + v;
  }
  return time;
}

export function isHandle(value: unknown): value is Handle {
  return typeof value === 'string' && HANDLE_RE.test(value);
}

export function handleFromSha256(sha256Hex: string): Handle {
  const handle = `art://${sha256Hex}` as const;
  if (!HANDLE_RE.test(handle)) throw new Error(`不是 sha256：${sha256Hex}`);
  return handle;
}

/** 内容的句柄：内容寻址，相同内容得到相同句柄 */
export function handleOf(content: string | Uint8Array): Handle {
  return handleFromSha256(createHash('sha256').update(content).digest('hex'));
}

export function sha256OfHandle(handle: Handle): string {
  return handle.slice('art://'.length);
}

/** 句柄在 Artifact store 和沙箱只读视图里的相对路径：<sha256 前两位>/<sha256> */
export function handlePath(handle: Handle): string {
  const sha = sha256OfHandle(handle);
  return `${sha.slice(0, 2)}/${sha}`;
}

function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > 0xffff_ffff_ffff) throw new Error(`时间超出 ULID 范围：${time}`);
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 位随机数，每 5 位一个字符
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING.charAt((buffer >> bits) & 31);
    }
  }
  return out;
}

function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const v = bytes[i] ?? 0;
    if (v < 255) {
      bytes[i] = v + 1;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}
