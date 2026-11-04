// 跑分用的任务：仿真任务（test/sim）和真实任务集（test/eval/real）用同一个形状。
// 仿真任务的 SimTask 原样就是 EvalTask；真实任务没有仿真环境（handler 不给），检查可能要在沙箱里跑交付的代码
// （代码题跑隐藏测试），所以检查可以是异步的、拿得到一个沙箱。

import type { CheckResult, Difficulty, Gate, SimWorld, SolveContext } from '../sim/task.ts';

/** 附件：仿真任务的都是文字；真实任务可以有二进制的（研究题的遥测文件） */
export interface EvalMaterial {
  name: string; // 容器里是 /melina/materials/<name>
  content: string | Uint8Array;
}

/**
 * 标准解、直接的做法拿到的附件是字符串（SolveContext.materials）：.bin 的按 latin1 转（一个字节一个字符，转回去不丢东西），
 * 别的按 UTF-8
 */
export function materialText(name: string, content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  return Buffer.from(content).toString(name.endsWith('.bin') ? 'latin1' : 'utf8');
}

/** 任务集：仿真（三类合成环境）、真实的代码题、真实的研究题；报告按它分组 */
export type Suite = 'sim' | 'code' | 'research';
export const SUITES: readonly Suite[] = ['sim', 'code', 'research'];
export const SUITE_LABEL: Record<Suite, string> = { sim: '仿真', code: '代码', research: '研究' };

/** 在沙箱里对一份交付跑一条命令（代码题跑隐藏测试）。dir 是宿主机上的一份可写拷贝，挂到 /workspace */
export type Sandbox = (
  dir: string,
  cmd: string,
  opts: { timeoutMs: number; domain: string },
) => Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

export interface EvalCheckContext {
  /** 跑分时给：Melina 用什么容器，这里就用什么（开发机是 proot）；没有就是 undefined，要跑代码的检查记成出错 */
  sandbox?: Sandbox;
}

export interface EvalWorld extends Omit<SimWorld, 'handler' | 'check' | 'materials' | 'starter'> {
  /** 仿真环境；真实任务没有 */
  handler?: SimWorld['handler'];
  /** 附件：接口说明、数据、样本文件 */
  materials(url: string): EvalMaterial[];
  /** 起点 workspace 里的文件：文本，或者要原样写的字节（比如 Windows-1252 编码的样本，code-statements）；都经 writeFiles 写盘 */
  starter(): Record<string, string | Uint8Array>;
  /** 在 Run 外面检查交付的 workspace（dir 是它的一份拷贝，可以改） */
  check(dir: string, ctx: EvalCheckContext): CheckResult | Promise<CheckResult>;
}

export interface EvalTask {
  id: string;
  /** 仿真任务是环境的种类（machine、service、constraints），真实任务是 code、research */
  env: string;
  suite?: Suite; // 不写是 sim
  difficulty: Difficulty;
  gate?: Gate; // 仿真任务对应的门槛
  title: string;
  domain: string;
  create(seed: string): EvalWorld;
  solve(ctx: SolveContext): Promise<void>;
  naive(ctx: SolveContext): Promise<void>;
}

export function suiteOf(task: Pick<EvalTask, 'suite'>): Suite {
  return task.suite ?? 'sim';
}
