// 宿主管理的任务在第一次环境交互前补齐控制文件。只取同一 Run 的宿主只读视图，
// 不从会被 snapshot 恢复的 workspace 或其他分支复制；常规调度继续负责刷新。
import { constants } from 'node:fs';
import { chmod, link, lstat, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { newId } from '../../src/core/ids.ts';
import type { Run } from '../../src/core/types.ts';
import type { ToolEnv } from '../../src/tools/session.ts';

const FILES = ['BENCHMARK_PROGRESS.json', 'BENCHMARK_INSTANCE.json'] as const;
const MAX_BYTES = 1024 * 1024;
const ready = new WeakSet<ToolEnv>();

/** 与宿主控制文件的就绪门禁共用识别规则，不给普通 CTF 注入平台操作细则。 */
export function usesHostFeedback({ goal }: Run): boolean {
  const contract = [goal.statement, goal.completion?.interpretation, ...(goal.completion?.criteria ?? [])];
  return FILES.every((name) => contract.some((text) => text?.includes(name)));
}

/** 最多短等一次，未就绪不执行工具；下一次调用重新检查，不把暂时缺失缓存为失败。 */
export async function prepareHostFeedback(
  env: ToolEnv,
  signal: AbortSignal,
  waitMs = 5000,
): Promise<string | undefined> {
  const { run, caller, deps } = env;
  if (!caller.container || (caller.role !== 'explorer' && caller.role !== 'scoper')) return;
  if (!usesHostFeedback(run)) return;
  if (signal.aborted) return '已取消，没有执行工具';
  if (ready.has(env)) return;
  await env.ready;
  const source = deps.views.scoperDir(run.id);
  const target = caller.branchId ? deps.views.branchDir(run.id, caller.branchId) : source;
  const deadline = performance.now() + waitMs;
  do {
    if (signal.aborted) return '已取消，没有执行工具';
    let complete = true;
    for (const name of FILES) {
      const path = join(target, name);
      let content = await feedback(path, run.id);
      if (!content && target !== source) {
        const stat = await lstat(source).catch(() => undefined);
        if (stat?.isDirectory()) {
          const seed = await feedback(join(source, name), run.id);
          if (seed) await seedMissing(path, seed).catch(() => {});
          content = await feedback(path, run.id);
        }
      }
      if (!content) complete = false;
    }
    if (signal.aborted) return '已取消，没有执行工具';
    if (complete) {
      ready.add(env);
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    try {
      await delay(Math.min(100, remaining), undefined, { signal });
    } catch {
      return '已取消，没有执行工具';
    }
  } while (!signal.aborted);
  if (signal.aborted) return '已取消，没有执行工具';
  deps.onNotice?.(`任务 ${run.id} 分支 ${caller.branchId ?? 'scoper'} 的宿主控制文件尚未就绪，本次工具未执行`);
  return '宿主的进度与实例文件尚未就绪，本次工具没有执行；稍后重试。';
}

async function feedback(path: string, runId: string): Promise<Buffer | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o222) !== 0 || stat.size > MAX_BYTES) return;
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== stat.size) return;
      const content = buffer.subarray(0, length);
      const value: unknown = JSON.parse(content.toString('utf8'));
      if (value && typeof value === 'object' && 'run_id' in value && value.run_id === runId) return content;
    } finally {
      await file.close();
    }
  } catch {
    // 宿主可能正在原子替换文件；留给本轮短等或下一次工具调用重试。
  }
  return;
}

/** 完整文件只在目标缺失时发布；不能用旧种子覆盖调度器刚写入的新反馈。 */
async function seedMissing(path: string, content: Buffer): Promise<void> {
  const temp = `${path}.${newId()}.tmp`;
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await chmod(temp, 0o444);
    await link(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
