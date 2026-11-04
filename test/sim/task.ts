// 仿真任务的约定。每个任务有：一句目标；评估用的固定完成标准和领域；
// 在 Run 外面跑的检查；一个能过检查的标准解，证明可解；难度标签。
//
// 交付物都写在 workspace 里（procedure.json、answer.json、deploy.json 这类数据文件），检查用和环境同一份规则核对，
// 不执行 agent 写的程序，也不看环境运行时的状态：几条分支各开各的会话，互不干扰，环境不算 sharedSystems。

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionSpec } from '../../src/core/types.ts';
import type { SimClock } from './kit/clock.ts';
import type { SimHandler } from './kit/http.ts';

export type EnvKind = 'machine' | 'service' | 'constraints' | 'tuning';
export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '难' };

/** 门槛：1 仿真任务端到端跑通；2 升级与 fork 场景；3 仿真难题上共享事实不差于全隔离 */
export type Gate = 1 | 2 | 3;

export interface MaterialFile {
  name: string; // 容器里是 /melina/materials/<name>
  content: string;
}

export interface CheckResult {
  pass: boolean;
  /** 一句话：过了说明交付了什么，没过说清哪里不对（只给评估和人看，不给 agent） */
  summary: string;
  /**
   * 没过、又分不清是交付的问题还是检查环境的问题时（一个测试都没跑起来、超时、被杀）写原因：
   * 跑分拿标准解在同一个沙箱里复跑一次当对照，标准解也没过就算检查环境出了问题、记成出错
   */
  suspect?: string;
}

/** 一个种子生成的世界：规则、数据、目标都定了 */
export interface SimWorld {
  readonly seed: string;
  /** 一句目标，url 是 agent 那边看到的环境地址 */
  statement(url: string): string;
  /** 评估时传给 Run 的固定完成标准；Scoper 保留给定标准并补充其余任务信息。 */
  completion(url: string): CompletionSpec;
  /** 附件：接口说明这类，只写公开的部分 */
  materials(url: string): MaterialFile[];
  /** 起点 workspace 里的文件 */
  starter(): Record<string, string>;
  /** 新的一份可变状态（会话、令牌、计数），挂到 SimServer 上 */
  handler(clock: SimClock): SimHandler;
  /** 检查要读的文件（相对 workspace 根）；跑分时只从交付里取这几个 */
  deliverables(): string[];
  /** 在 Run 外面检查交付的 workspace（dir 是它的一份拷贝） */
  check(dir: string): CheckResult;
  /** 世界的要点：目标值、规则摘要。只进评估的存档，不给 agent */
  summary(): Record<string, unknown>;
}

/** 标准解和直接的做法拿到的东西，和 agent 拿到的一样：目标、附件、环境地址，加一个可写的目录 */
export interface SolveContext {
  url: string;
  dir: string;
  statement: string;
  materials: Record<string, string>; // 附件名 → 内容
  /** 按 Retry-After 等的时候用；单元测试里是虚拟时钟 */
  sleep(ms: number): Promise<void>;
}

export interface SimTask {
  id: string; // 例如 machine-hard
  env: EnvKind;
  difficulty: Difficulty;
  gate: Gate;
  title: string; // 给人看的短名，例如「灌装机控制器（难）」
  domain: string; // 评估时固定传的领域
  create(seed: string): SimWorld;
  /** 标准解：只用接口和附件，把交付物写进 ctx.dir */
  solve(ctx: SolveContext): Promise<void>;
  /** 直接的做法：只照附件写的来、不深究。中等和难的任务上它必须过不了检查，证明藏起来的部分是真要摸清的 */
  naive(ctx: SolveContext): Promise<void>;
}

/** 检查时读交付的文件：不存在、不是普通文件（符号链接也不认，免得读到宿主机上的东西）、太大都返回原因 */
export function readDeliverable(
  dir: string,
  name: string,
  maxBytes = 1024 * 1024,
): { text: string } | { error: string } {
  const path = join(dir, name);
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { error: `${name} 不是普通文件` };
    size = st.size;
  } catch {
    return { error: `工作目录里没有 ${name}` };
  }
  if (size > maxBytes) return { error: `${name} 太大（${size} 字节）` };
  return { text: readFileSync(path, 'utf8') };
}

/** 开头带 UTF-8 BOM 的照收：环境的接口收请求体时先 trim 掉了它，检查不能比接口还严 */
export function parseJson(text: string, name: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (e) {
    return { error: `${name} 不是合法的 JSON：${(e as Error).message}` };
  }
}
