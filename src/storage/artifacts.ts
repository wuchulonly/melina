// Artifact store：按内容寻址，artifacts/<runId>/<sha256 前两位>/<sha256>，句柄即 art://<sha256>。
// 同一个 Run 里相同内容只存一份。先写临时文件再改名，写完的文件只读：内容和句柄永远对得上，也不会有写了一半的文件。
// 调用方先 put 拿到句柄，再在 RunStoreWriter 的事务里引用它，保证不会出现悬空句柄。

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { invalid, notFound } from '../core/errors.ts';
import { type Handle, handleFromSha256, handleOf, handlePath, type Id, isHandle, isId } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';

const READ_ONLY = 0o444;

export class FileArtifactStore implements ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(runId: Id, content: string | Uint8Array): Promise<Handle> {
    const handle = handleOf(content);
    const target = this.path(runId, handle);
    if (existsSync(target)) return handle;
    await mkdir(dirname(target), { recursive: true });
    const temp = tempPath(target);
    await writeFile(temp, content, { mode: READ_ONLY });
    await settle(temp, target);
    return handle;
  }

  async putFile(runId: Id, path: string): Promise<Handle> {
    const runDir = this.runDir(runId);
    await mkdir(runDir, { recursive: true });
    const temp = tempPath(join(runDir, 'incoming'));
    const hash = createHash('sha256');
    try {
      await pipeline(
        createReadStream(path),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(temp, { mode: READ_ONLY }),
      );
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    const handle = handleFromSha256(hash.digest('hex'));
    const target = this.path(runId, handle);
    await mkdir(dirname(target), { recursive: true });
    await settle(temp, target);
    return handle;
  }

  async has(runId: Id, handle: Handle): Promise<boolean> {
    try {
      await access(this.path(runId, handle));
      return true;
    } catch {
      return false;
    }
  }

  /** 同步版的 has：RunStoreWriter 在事务里查句柄用（better-sqlite3 的事务是同步的） */
  hasSync(runId: Id, handle: Handle): boolean {
    return existsSync(this.path(runId, handle));
  }

  async read(runId: Id, handle: Handle): Promise<Uint8Array> {
    try {
      return await readFile(this.path(runId, handle));
    } catch (error) {
      throw missing(error, handle);
    }
  }

  /** 按行读（artifact_read）：offset 从 1 数，不给 limit 就读到末尾；最后一个换行后面没有内容时不算一行 */
  async readLines(
    runId: Id,
    handle: Handle,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<{ text: string; totalLines: number }> {
    const offset = Math.max(1, Math.floor(opts.offset ?? 1));
    const limit = opts.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(opts.limit));
    const file = this.path(runId, handle);
    if (!existsSync(file)) throw missing(undefined, handle);
    const lines: string[] = [];
    let totalLines = 0;
    const reader = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of reader) {
      totalLines++;
      if (totalLines >= offset && lines.length < limit) lines.push(line);
    }
    return { text: lines.join('\n'), totalLines };
  }

  async stat(runId: Id, handle: Handle): Promise<{ size: number } | undefined> {
    try {
      const s = await stat(this.path(runId, handle));
      return { size: s.size };
    } catch {
      return undefined;
    }
  }

  path(runId: Id, handle: Handle): string {
    if (!isHandle(handle)) throw invalid(`不是句柄：${String(handle)}`);
    return join(this.runDir(runId), handlePath(handle));
  }

  /** 复制到另一个 Run（接着做）：内容不变，能硬链接就硬链接 */
  async copy(fromRunId: Id, handle: Handle, toRunId: Id): Promise<Handle> {
    const source = this.path(fromRunId, handle);
    const target = this.path(toRunId, handle);
    if (existsSync(target)) return handle;
    if (!existsSync(source)) throw missing(undefined, handle);
    await mkdir(dirname(target), { recursive: true });
    try {
      await link(source, target);
    } catch (error) {
      if (existsSync(target)) return handle;
      if (!isCode(error, 'EXDEV') && !isCode(error, 'EPERM') && !isCode(error, 'EMLINK')) throw error;
      const temp = tempPath(target);
      await copyFile(source, temp);
      await chmod(temp, READ_ONLY);
      await settle(temp, target);
    }
    return handle;
  }

  async deleteRun(runId: Id): Promise<void> {
    await rm(this.runDir(runId), { recursive: true, force: true });
  }

  private runDir(runId: Id): string {
    if (!isId(runId)) throw invalid(`不是 Run 的 id：${String(runId)}`);
    return join(this.root, runId);
  }
}

function tempPath(target: string): string {
  return `${target}.${randomBytes(6).toString('hex')}.tmp`;
}

/** 临时文件改名成正式的；已经有了（并发写了同样的内容）就删掉临时的 */
async function settle(temp: string, target: string): Promise<void> {
  if (existsSync(target)) {
    await unlink(temp);
    return;
  }
  await rename(temp, target);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function missing(error: unknown, handle: Handle): Error {
  if (error === undefined || isCode(error, 'ENOENT')) return notFound(`产物 ${handle} 不存在`);
  return error as Error;
}
