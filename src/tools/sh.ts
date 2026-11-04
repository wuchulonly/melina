// sh：交给调用方容器里的 bash，工作目录是它的 workspace，带超时；取消时杀掉整个进程组（容器运行时做）。
// sh 调用执行前先写一条 sh.intent，id 就是之后那条 Observation 的 id；expect 可选。
// background 时立即返回 pid 和日志文件路径，进程跨调用、跨 episode 存活。
// 前台命令最多跑 FOREGROUND_MAX_MS：要跑更久用 background，之后看日志。
// 命令跑的时候撞到了资源上限：容器运行时量的 cgroup 计数，真撞了才记进
// Observation.contention，连同这段时间里也在跑命令的别的路线；进程数、内存撞上限还写在摘要第一行，跑命令的路线当场看到。
// 不拦、不判这条命令的结果算不算数：撞的是谁的上限、同时谁在跑，照实写，由读的人判断。

import { alongsideText, contentionShown, contentionText } from '../context/evidence.ts';
import type { Id } from '../core/ids.ts';
import type { ContainerExecResult } from '../core/interfaces/container.ts';
import type { ToolOutcome } from '../core/interfaces/gateway.ts';
import { type ShArgs, TOOL } from '../core/tools.ts';
import type { Contention, ExecContention } from '../core/types.ts';
import { withBatchCommand } from './batch.ts';
import { outputInspector } from './extensions.ts';
import { observe } from './observe.ts';
import { checkTool, fail, messageOf, type ToolEnv, toolSlot } from './session.ts';

/** setTimeout 能等的最长时间；再长 Node 会当成 1 毫秒 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 前台命令最多跑多久：模型给的 timeoutMs、配置的默认超时都不超过它；后台命令不受它管。
 * 原来模型可以把超时设到几十分钟，路线就在一条命令上干等：开发集 以后 43 局，跑过 5 分钟的前台命令 13 条，
 * 6 条跑满超时什么都没拿到（最长 15 分钟），5 条是 sleep 300 在等，真在干活的 2 条。
 * 改这个数要一起改 core/tools.ts 里 timeoutMs 的说明
 */
export const FOREGROUND_MAX_MS = 5 * 60_000;

/**
 * 一半以上的时间有进程在等 CPU 才记：偶尔排一下队是常态，记下来的应该是量出来的数可能被拖慢的那种。
 * 记了也只在读数上说（context/evidence.ts 的 contentionShown）
 */
export const CPU_WAIT_NOTE = 0.5;

export async function runSh(env: ToolEnv, args: ShArgs, signal: AbortSignal): Promise<ToolOutcome> {
  if (!env.caller.container) return fail('这次调用没有容器，sh 用不了');
  const expect = args.expect?.trim();
  await env.ready;
  if (signal.aborted) return fail('已取消，命令没有执行');
  // 先拿到本机执行的名额再写意图：排队时被取消的调用没执行，不能留下一条「不知道生效没有」的意图
  let slot: Awaited<ReturnType<typeof toolSlot>>;
  try {
    slot = await toolSlot(env, signal);
  } catch (e) {
    return fail(`命令没有执行：${messageOf(e)}`);
  }
  if (!slot) return fail('已取消，命令没有执行');
  let collector: ReturnType<typeof outputInspector> | undefined;
  let outcome: ToolOutcome;
  try {
    // 排队期间巡检器可能换了地图：在写意图、启动命令之前再查一次，拒绝不算已执行。
    const blocked = checkTool(env, { name: TOOL.sh, args });
    if (blocked !== undefined) return fail(blocked);
    collector = args.background ? undefined : outputInspector(env);
    outcome = await execSh(env, args, expect, signal, collector?.inspect);
  } finally {
    slot.release();
  }
  // 扩展可能等待工具名额，先归还再提交存档后的元数据。
  return collector ? collector.finish(outcome) : outcome;
}

async function execSh(
  env: ToolEnv,
  args: ShArgs,
  expect: string | undefined,
  signal: AbortSignal,
  inspectPrivate?: (output: string) => string,
): Promise<ToolOutcome> {
  const { deps, caller, run } = env;
  if (!caller.container) return fail('这次调用没有容器，sh 用不了');
  const startedAt = Date.now();
  const id = deps.newId();
  if (writesIntent(env)) {
    // 先写意图再执行：恢复时只有意图、没有 Observation 的调用视为结果未知
    try {
      deps.writer.appendShIntent(run.id, {
        id,
        branchId: caller.branchId as string,
        episode: caller.episode as number,
        cmd: deps.redactor.redact(args.cmd),
        ...(expect ? { expect: deps.redactor.redact(expect) } : {}),
      });
    } catch (error) {
      return fail(`这次命令没有执行：${messageOf(error)}`);
    }
  }

  const asked = args.timeoutMs ?? run.config.sh.timeoutMs;
  const timeoutMs = Math.min(asked, args.background ? MAX_TIMEOUT_MS : FOREGROUND_MAX_MS);
  // 后台命令立即返回，跑的那段时间不在这里：不登记，也没有撞线的计数
  const finished = args.background ? undefined : deps.running?.start(run.id, caller.branchId);
  let result: ContainerExecResult | undefined;
  let error: string | undefined;
  try {
    result = await deps.runtime.exec(caller.container, {
      cmd: withBatchCommand(args.cmd),
      timeoutMs,
      env: { MELINA_SH_DEADLINE_MS: args.background ? '' : String(Date.now() + timeoutMs) },
      signal,
      ...(args.background ? { background: true } : {}),
      ...(inspectPrivate ? { inspectPrivate } : {}),
    });
  } catch (e) {
    error = messageOf(e);
  }
  const contention = noted(result?.contention, finished?.() ?? []);

  const recorded: Record<string, unknown> = { cmd: args.cmd };
  if (expect) recorded.expect = expect;
  if (args.timeoutMs !== undefined) recorded.timeoutMs = args.timeoutMs;
  if (args.background) recorded.background = true;

  return observe(env, {
    id,
    tool: 'sh',
    args: recorded,
    ...(expect ? { expect } : {}),
    raw: result?.output ?? '',
    head: headLine(result, error, timeoutMs, asked) + contentionClause(env, contention),
    ...(result?.exitCode !== undefined && result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(failure(result, error, timeoutMs) ? { error: failure(result, error, timeoutMs) } : {}),
    ...(contention ? { contention } : {}),
    startedAt,
  });
}

/**
 * 记进 Observation 的撞线：进程数撞到上限、有进程因为内存超限被杀，或者一半以上的时间在等 CPU，才算撞了；
 * 没撞的项不记。alongside 是这条命令跑的时候也在跑命令的别的路线
 */
function noted(measured: ExecContention | undefined, alongside: readonly Id[]): Contention | undefined {
  if (!measured) return undefined;
  const out: Contention = { scope: measured.scope };
  if (measured.pidsMax) out.pidsMax = measured.pidsMax;
  if (measured.oomKills) out.oomKills = measured.oomKills;
  if (measured.cpuWait !== undefined && measured.cpuWait >= CPU_WAIT_NOTE) {
    out.cpuWait = Math.round(measured.cpuWait * 100) / 100;
  }
  if (out.pidsMax === undefined && out.oomKills === undefined && out.cpuWait === undefined) return undefined;
  return alongside.length > 0 ? { ...out, alongside: [...alongside] } : out;
}

/**
 * 摘要第一行后面那一句：进程数、内存撞到上限时写，跑命令的路线当场就知道这次的结果可能不是命令本身的事；
 * 只是等 CPU 不写（只在读数上说，见 CPU_WAIT_NOTE）
 */
function contentionClause(env: ToolEnv, c: Contention | undefined): string {
  const shown = c && contentionShown(c, { reading: false });
  if (!shown) return '';
  const { queries } = env.deps;
  const labels = (shown.alongside ?? []).map((id) => {
    const branch = queries.getBranch(id);
    return (branch && queries.getBet(branch.betId)?.label) ?? '另一条路线';
  });
  return `；跑的时候${contentionText(shown)}${alongsideText(shown, labels)}`;
}

/**
 * sh.intent 只给分支的 episode 写：恢复时它提示的是那条分支的 Explorer。
 * Scoper 不属于在跑的 episode，不写。
 */
function writesIntent(env: ToolEnv): boolean {
  const { caller } = env;
  return caller.role === 'explorer' && caller.branchId !== undefined && caller.episode !== undefined;
}

function headLine(
  result: ContainerExecResult | undefined,
  error: string | undefined,
  timeoutMs: number,
  asked: number,
): string {
  if (!result) return `没跑起来：${error ?? '容器出错'}`;
  if (result.timedOut) {
    return `超时：${seconds(timeoutMs)} 秒还没跑完，已经连同它起的进程一起杀掉；下面是已有的输出（${longer(timeoutMs, asked)}）。这是整条命令的总时限，等待和所有子命令都计时，有输出也不会续期；已产生的文件和外部影响不会回滚，已有输出不表示整批完成。继续前先核对已完成部分及外部结果，只继续确认未完成且可安全重试的部分。已有 melina-batch 批次先查 status，沿用原清单和状态目录只续跑 pending；失败、超时、取消或未知项核对后显式 --retry`;
  }
  if (result.cancelled) return '被取消了，进程已经杀掉；下面是已有的输出';
  if (result.background) {
    const { pid, log } = result.background;
    return `已在后台启动：pid ${pid}，日志在 ${log}（用 sh 看，比如 tail -n 50 ${log}；停掉用 kill ${pid}）。这次只确认启动，命令仍可能运行或失败；timeoutMs 不限制后台运行时长`;
  }
  const took = result.durationMs >= 1000 ? `，用时 ${seconds(result.durationMs)} 秒` : '';
  const empty = result.output === '' ? '，没有输出' : '';
  return `退出码 ${result.exitCode ?? '未知'}${took}${empty}`;
}

/** 超时后按任务选择：批量优先分批保存，长任务用后台；单项预算明确时才提示调整前台时限。 */
function longer(timeoutMs: number, asked: number): string {
  const limit = `前台命令最多跑 ${FOREGROUND_MAX_MS / 60_000} 分钟`;
  const later =
    '批量任务优先用 melina-batch 按剩余预算分批保存；需连续长跑用 background，并由程序设置总期限，之后看日志';
  if (timeoutMs < FOREGROUND_MAX_MS) return `${later}；单项任务确认所需总时长后可调整 timeoutMs，${limit}`;
  if (asked > timeoutMs) return `你给的 timeoutMs 是 ${seconds(asked)} 秒，${limit}；${later}`;
  return `${limit}，${later}`;
}

function failure(result: ContainerExecResult | undefined, error: string | undefined, timeoutMs: number) {
  if (!result) return `没跑起来：${error ?? '容器出错'}`;
  if (result.timedOut) return `超时（${seconds(timeoutMs)} 秒）`;
  if (result.cancelled) return '被取消';
  return undefined;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return s >= 10 ? String(Math.round(s)) : s.toFixed(1).replace(/\.0$/, '');
}
