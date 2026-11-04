// POST /runs 的附件：一个叫 run 的字段放 CreateRunRequest 的 JSON，
// 附件放在叫 materials 的文件字段里，可以多个，保留原文件名（core/api.ts）。
// 边收边写临时文件，不在内存里攒整个请求；RunManager.create 把它们存进 Artifact store 以后，调用方删掉临时目录。

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { invalid, MelinaError } from '../core/errors.ts';

export interface UploadLimits {
  /** 附件个数 */
  maxFiles: number;
  /** 单个附件的字节数 */
  maxFileBytes: number;
  /** 所有附件加起来的字节数 */
  maxTotalBytes: number;
  /** run 字段（JSON）的字节数 */
  maxFieldBytes: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFiles: 100,
  maxFileBytes: 2 * 1024 ** 3,
  maxTotalBytes: 4 * 1024 ** 3,
  maxFieldBytes: 1024 ** 2,
};

export interface UploadedFile {
  /** 原文件名（只取最后一段） */
  name: string;
  /** 临时文件 */
  path: string;
  size: number;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: UploadedFile[];
  /** 临时目录，用完调 cleanup 删掉 */
  dir: string;
  cleanup(): Promise<void>;
}

/** 收一个 multipart/form-data 请求：fileField 里的文件写进 root 下新建的临时目录，其余文件字段丢掉 */
export async function readMultipart(
  request: Request,
  root: string,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
  fileField = 'materials',
): Promise<MultipartResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!request.body) throw invalid('请求体是空的');
  const dir = join(root, randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  try {
    await receive(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), {
      contentType,
      limits,
      fileField,
      onField: (name, value) => {
        fields[name] = value;
      },
      newFile: (name) => {
        const file: UploadedFile = { name, path: join(dir, String(files.length)), size: 0 };
        files.push(file);
        return file;
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { fields, files, dir, cleanup };
}

interface ReceiveOptions {
  contentType: string;
  limits: UploadLimits;
  fileField: string;
  onField(name: string, value: string): void;
  newFile(name: string): UploadedFile;
}

function receive(source: Readable, opts: ReceiveOptions): Promise<void> {
  const { limits } = opts;
  return new Promise<void>((resolveAll, rejectAll) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: { 'content-type': opts.contentType },
        defParamCharset: 'utf8', // 浏览器把中文文件名按 UTF-8 原样放在引号里
        limits: {
          files: limits.maxFiles,
          fileSize: limits.maxFileBytes + 1, // 正好 maxFileBytes 的不算超；超了的由下面的计数拦
          fields: 20,
          fieldSize: limits.maxFieldBytes,
          parts: limits.maxFiles + 20,
        },
      });
    } catch {
      rejectAll(invalid('请求体不是 multipart/form-data'));
      return;
    }
    let settled = false;
    let total = 0;
    const writes: Promise<void>[] = [];
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error === undefined) {
        resolveAll();
        return;
      }
      const reason = error instanceof MelinaError ? error : invalid('附件没传完整，再试一次');
      // 不再往解析器里送，剩下的读完扔掉（不 destroy 请求体：它可能还在往里写，硬断会在别处抛错）
      source.unpipe(parser);
      source.resume();
      // 解析器 destroy 时连带 destroy 正在收的那个文件流，写文件的 pipeline 跟着结束、fd 关上；
      // 等所有写都停了再报错，调用方删临时目录时不会有还开着的文件（中途断开的上传不留占着磁盘的 fd）
      parser.destroy(reason);
      void Promise.allSettled(writes).then(() => rejectAll(reason));
    };

    parser.on('file', (field, stream, info) => {
      if (settled || field !== opts.fileField) {
        stream.on('error', () => {}); // 解析器 destroy 时会带着错误 destroy 它
        stream.resume();
        return;
      }
      const file = opts.newFile(cleanFileName(info.filename));
      const count = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          file.size += chunk.length;
          total += chunk.length;
          if (file.size > limits.maxFileBytes) {
            callback(invalid(`附件「${file.name}」太大：单个最多 ${formatBytes(limits.maxFileBytes)}`));
            return;
          }
          if (total > limits.maxTotalBytes) {
            callback(invalid(`附件加起来太大：最多 ${formatBytes(limits.maxTotalBytes)}`));
            return;
          }
          callback(null, chunk);
        },
      });
      stream.on('limit', () =>
        finish(invalid(`附件「${file.name}」太大：单个最多 ${formatBytes(limits.maxFileBytes)}`)),
      );
      const write = pipeline(stream, count, createWriteStream(file.path, { mode: 0o600 }));
      write.catch(finish);
      writes.push(write);
    });
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated) finish(invalid(`字段 ${name} 太长：最多 ${formatBytes(limits.maxFieldBytes)}`));
      else opts.onField(name, value);
    });
    parser.on('filesLimit', () => finish(invalid(`附件最多 ${limits.maxFiles} 个`)));
    parser.on('fieldsLimit', () => finish(invalid('字段太多')));
    parser.on('partsLimit', () => finish(invalid('请求里的部分太多')));
    parser.on('error', finish);
    parser.on('close', () => {
      Promise.all(writes).then(() => finish(), finish);
    });
    source.on('error', finish);
    source.pipe(parser);
  });
}

/** 原文件名只取最后一段：去掉路径、控制字符和首尾空白；剩下空的就叫「附件」 */
export function cleanFileName(raw: string | undefined): string {
  const last = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符
  const name = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name === '' || name === '.' || name === '..' ? '附件' : name;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${+(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KiB`;
  return `${n} 字节`;
}
