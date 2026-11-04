// API key 和凭证的加密：AES-256-GCM，密钥 32 字节。
//
// 密钥从哪来：环境变量 MELINA_SECRET_KEY（base64 或 hex 的 32 字节），否则数据库旁边的密钥文件（权限 0600，第一次用时生成）。
// 防的是数据库文件单独流出去（备份、拷给别人排查问题、被别的程序读到）：只拿到数据库解不开。
// 密钥文件和数据库放在一起时，拿到整个数据目录的人照样解得开；要分开放就用环境变量。
//
// 密文格式：版本（1 字节）+ IV（12 字节）+ 认证标签（16 字节）+ 密文。附加数据（AAD）是这一行的身份
// （例如 provider:deepseek、credential:<id>），把一行的密文挪到另一行解不开。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { MelinaError } from '../core/errors.ts';

const VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export const SECRET_KEY_ENV = 'MELINA_SECRET_KEY';

export interface SecretBox {
  seal(plain: string, aad: string): Buffer;
  /** 解不开（密钥换了、数据坏了）返回 undefined */
  open(sealed: Uint8Array, aad: string): string | undefined;
}

export function createSecretBox(key: Uint8Array): SecretBox {
  if (key.length !== KEY_BYTES)
    throw new MelinaError('internal', `密钥要 ${KEY_BYTES} 字节，给的是 ${key.length} 字节`);
  const k = Buffer.from(key);
  return {
    seal(plain, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', k, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(sealed, aad) {
      const buf = Buffer.from(sealed);
      if (buf.length < HEADER_BYTES || buf[0] !== VERSION) return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, buf.subarray(1, 1 + IV_BYTES));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(buf.subarray(1 + IV_BYTES, HEADER_BYTES));
        return Buffer.concat([decipher.update(buf.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** 环境变量里的密钥：base64（44 个字符）或 hex（64 个字符）的 32 字节 */
export function parseSecretKey(text: string): Buffer {
  const t = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new MelinaError(
      'invalid',
      `${SECRET_KEY_ENV} 要是 32 字节的 base64 或 hex（openssl rand -base64 32 生成一个）`,
    );
  }
  return key;
}

/**
 * 读密钥文件，没有就生成一个（0600，只有自己能读）。几个进程同时第一次启动时只有一个能建成，其余的读它建好的。
 * 文件里是 base64 的 32 字节加换行。
 */
export function loadOrCreateKeyFile(path: string): Buffer {
  const existing = readKeyFile(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // 另一个进程刚建好，可能还没写完：等它一会儿
    for (let i = 0; i < 50; i++) {
      const raced = readKeyFile(path);
      if (raced) return raced;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    throw new MelinaError('internal', `密钥文件 ${path} 是空的：删掉它再启动（空文件里没有密钥，删了不丢东西）`);
  }
  try {
    writeSync(fd, `${key.toString('base64')}\n`);
  } finally {
    closeSync(fd);
  }
  return key;
}

function readKeyFile(path: string): Buffer | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!text.trim()) return undefined; // 另一个进程刚建、还没写完
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new MelinaError(
      'internal',
      `密钥文件 ${path} 坏了：不是 32 字节的 base64。删掉它会丢掉所有 API key 和凭证，要重新填`,
    );
  }
  return key;
}
