// 外部验收是完成条件时，先读宿主只读视图，再决定是否接受最终候选。
// 等待、拒绝或缺少反馈都不是收尾格式错误，不消耗返修次数，不结束当前会话。
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { currentRun, type ToolEnv } from '../../src/tools/session.ts';
import { usesHostFeedback } from './host-feedback.ts';

const PROGRESS_FILE = 'BENCHMARK_PROGRESS.json';
const MAX_BYTES = 1024 * 1024;

export async function pendingAcceptance(env: ToolEnv, signal: AbortSignal): Promise<string | undefined> {
  const run = currentRun(env);
  // 宿主协议与提示注入共用识别条件，不因 Scoper 省略文件名而失去验收门禁。
  // 其他任务仅在完成标准明确引用进度文件时启用；尚未起草标准时使用题面。
  const completion = run.goal.completion;
  const contract = completion ? [completion.interpretation, ...completion.criteria] : [run.goal.statement];
  if (!usesHostFeedback(run) && !contract.some((text) => text?.includes(PROGRESS_FILE))) return undefined;
  const unknown =
    '平台验收尚未确认，最终候选暂不接受，当前会话继续。读取 /melina/artifacts/BENCHMARK_PROGRESS.json；' +
    '反馈缺失、不可读或通信失败都不代表完成。已有候选由宿主采集提交，继续处理仍未验收的目标，不要为等待反馈收尾。';
  if (signal.aborted) return unknown;
  const dir = env.caller.branchId
    ? env.deps.views.branchDir(run.id, env.caller.branchId)
    : env.deps.views.scoperDir(run.id);
  const path = join(dir, PROGRESS_FILE);
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return unknown;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES || signal.aborted) return unknown;
      const progress: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (!progress || typeof progress !== 'object') return unknown;
      const p = progress as Record<string, unknown>;
      const code = /\bunique_code\s*[:=]\s*([A-Za-z0-9_-]+)/.exec(run.goal.statement)?.[1];
      if (p.run_id !== run.id || (code !== undefined && p.unique_code !== code)) return unknown;
      const total = p.flag_count;
      const correct = p.correct_flag_count;
      const remaining = p.remaining_flag_count;
      if (!count(total) || total === 0 || !count(correct) || !count(remaining)) return unknown;
      if (remaining === 0 && (p.is_completed === true || correct >= total)) return undefined;
      if (remaining !== Math.max(0, total - correct)) return unknown;
      return (
        `平台已验收 ${correct}/${total}，还剩 ${remaining} 项；最终候选暂不接受，当前会话继续。` +
        '单项提交不结束任务。读取 /melina/artifacts/BENCHMARK_PROGRESS.json，沿已有证据继续补齐；' +
        '拒绝只否定该字符串，不能据此否定整条方向。全部验收后再请求最终交付。'
      );
    } finally {
      await file.close();
    }
  } catch {
    return unknown;
  }
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
