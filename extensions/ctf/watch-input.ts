import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WatcherInputSink } from '../../src/api/extensions.ts';
import type { InfraDeps } from '../../src/api/sdk.ts';
import { sameValue } from '../../src/api/watch-input.ts';
import type { Id } from '../../src/core/ids.ts';
import type { Branch } from '../../src/core/types.ts';
import { issues } from '../../src/core/validate.ts';
import { FeedbackSource, WATCH_INPUT, type WatchPlatform } from '../../src/core/watch-input.ts';
import { watchInputText, watchSourceText } from '../../src/projections/watch.ts';

type Deps = Pick<InfraDeps, 'queries'> & { paths: Pick<InfraDeps['paths'], 'dataDir'> };

export class BenchmarkWatchInputs {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async collect(runId: Id, branchId: Id, input: WatcherInputSink): Promise<undefined> {
    const run = this.deps.queries.getRun(runId);
    const branch = this.deps.queries.getBranch(branchId);
    if (!run || !branch || branch.runId !== run.id || run.goal.domain !== 'ctf') return;
    input.signal.throwIfAborted();
    try {
      // 只读挂载的宿主文件，绝不把主代理可改的 workspace 副本当验收依据。
      const path = join(this.deps.paths.dataDir, run.id, 'views', branch.id, 'BENCHMARK_PROGRESS.json');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: unknown;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1_000_000) throw new Error('平台状态无效');
        raw = JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
      if (!raw || typeof raw !== 'object' || !('run_id' in raw) || raw.run_id !== run.id)
        throw new Error('平台状态不属于当前任务');
      const platform = platformState(raw);
      for (const flag of platform.accepted) {
        const old = input
          .observations()
          .find(
            (o) =>
              o.role === 'watcher' &&
              o.tool === WATCH_INPUT.receipt &&
              (o.args as { id?: string } | null)?.id === flag.id &&
              sameValue((o.args as { source?: FeedbackSource } | null)?.source, flag.source),
          );
        flag.receipt =
          old?.id ??
          (await input.save(
            WATCH_INPUT.receipt,
            `平台已验收：${flag.label}\n来源：${watchSourceText(flag.source)}`,
            flag,
            false,
          ));
      }
      await input.save(WATCH_INPUT.platform, watchInputText(WATCH_INPUT.platform, platform), platform);
    } catch {
      await input.save(WATCH_INPUT.platform, '当前平台状态不可用：未收到有效的宿主进度文件；不能据此判定完成。', {});
    }
    await this.traffic(branch, input);
    return undefined;
  }

  /** 编排器为每个实例世代保留的独立请求/响应记录，作为测量材料而非平台验收依据。 */
  private async traffic(branch: Branch, input: WatcherInputSink): Promise<void> {
    if (!branch.workspace) return;
    const root = join(branch.workspace.path, 'BENCHMARK_TRAFFIC');
    // 沿已打开的目录句柄读取，日志和任意一层目录都不能通过符号链接跨出本分支。
    let visited = 0;
    const visit = async (directory: FileHandle, relative: string, depth: number): Promise<void> => {
      try {
        const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > 100) break;
          const path = join(relative, entry.name);
          const local = `/proc/self/fd/${directory.fd}/${entry.name}`;
          if (entry.isDirectory() && depth < 2) {
            let child: FileHandle;
            try {
              child = await open(local, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            } catch {
              continue;
            }
            await visit(child, path, depth + 1);
            continue;
          }
          if (!entry.isFile() || !/\.(?:log|json|jsonl|har|txt)$/i.test(entry.name)) continue;
          let file: FileHandle;
          try {
            file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          } catch {
            continue;
          }
          try {
            const size = (await file.stat()).size;
            const buffer = Buffer.alloc(Math.min(size, 64_000));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            if (!/https?:\/\/|HTTP\/\d|"request"|"response"/.test(text)) continue;
            const output = `独立 HTTP 记录 BENCHMARK_TRAFFIC/${path}（${size} 字节，最多保留末尾 64000 字节）\n${text}`;
            await input.save(WATCH_INPUT.http, output, { path });
          } finally {
            await file.close();
          }
        }
      } finally {
        await directory.close();
      }
    };
    let directory: FileHandle;
    try {
      directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      return;
    }
    await visit(directory, '', 0);
  }
}

/** 仅接受平台的明确回执列表；计数或主代理自述都不能生成 flag。 */
export function platformState(raw: unknown): WatchPlatform {
  if (!raw || typeof raw !== 'object') throw new Error('平台状态不是对象');
  const p = raw as Record<string, unknown>;
  const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((s) => typeof s === 'string' && s.length > 0);
  if (
    typeof p.unique_code !== 'string' ||
    !p.unique_code ||
    !integer(p.flag_count) ||
    !integer(p.remaining_flag_count) ||
    p.remaining_flag_count > p.flag_count ||
    !strings(p.accepted_flags) ||
    !strings(p.rejected_flags) ||
    (p.filtered_local_candidates !== undefined && !strings(p.filtered_local_candidates)) ||
    typeof p.hint_status !== 'string' ||
    (p.hint !== null && typeof p.hint !== 'string')
  )
    throw new Error('平台状态字段不完整');
  return {
    task: p.unique_code,
    total: p.flag_count,
    remaining: p.remaining_flag_count,
    hintStatus: p.hint_status,
    hint: p.hint ?? '',
    rejectedCount: p.rejected_flags.length,
    ...(p.filtered_local_candidates?.length ? { filteredCount: p.filtered_local_candidates.length } : {}),
    accepted: [...new Set(p.accepted_flags)].map((flag) => ({
      id: `flag-${createHash('sha256').update(`${p.unique_code}\n${flag}`).digest('hex').slice(0, 24)}`,
      label: flag,
      ...sourceOf(p.accepted_sources, flag),
    })),
  };
}

function sourceOf(raw: unknown, flag: string): { source?: FeedbackSource } {
  if (!raw || typeof raw !== 'object') return {};
  const item = (raw as Record<string, unknown>)[flag];
  if (!item || typeof item !== 'object') return {};
  const value = item as Record<string, unknown>;
  const source = {
    runId: value.run_id,
    branchId: value.branch_id,
    observationId: value.observation_id,
    ...(value.output ? { output: value.output } : {}),
    ...(value.tool ? { tool: value.tool } : {}),
    ...(value.command ? { command: value.command } : {}),
  };
  return issues(FeedbackSource, source).length ? {} : { source: source as FeedbackSource };
}
