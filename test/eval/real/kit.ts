// 真实任务集的骨架。
// 选的是离线、自己出的题：只要 python3、git、bash，不联网；题目和答案不在网上，模型背不到。
// - 代码题：起点是一个小仓库（Python 标准库），交付是改好的仓库；检查在沙箱里跑隐藏测试（agent 看不到），全过才算过。
// - 研究题：附件是数据、日志或文件样本，交付是 answer.json（另写 report.md，只存档、不判分）；检查和真值比。
// 题目文件放在各题的目录下（starter/、hidden/、solution/），按需读出来；研究题的数据按种子生成，每次试验一份新的。

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompletionSpec } from '../../../src/core/types.ts';
import type { CheckResult, Difficulty, SolveContext } from '../../sim/task.ts';
import type { EvalCheckContext, EvalMaterial, EvalTask, EvalWorld, Sandbox } from '../task.ts';
import { writeFiles } from '../workspace.ts';

export interface RealTaskDef {
  id: string;
  suite: 'code' | 'research';
  difficulty: Difficulty;
  title: string;
  domain: string;
  statement: (seed: string) => string;
  completion: (seed: string) => CompletionSpec;
  starter: (seed: string) => Record<string, string>;
  materials: (seed: string) => EvalMaterial[];
  /** 检查要读的文件；空数组是整个 workspace（代码题） */
  deliverables: string[];
  check: (dir: string, ctx: EvalCheckContext, seed: string) => CheckResult | Promise<CheckResult>;
  /** 标准解：只用目标和附件（研究题），或者照 solution/ 改好（代码题），写进 ctx.dir */
  solve: (ctx: SolveContext) => Promise<void>;
  /** 直接的做法：中等和难的题上必须过不了检查 */
  naive: (ctx: SolveContext) => Promise<void>;
  /** 只进评估的存档：真值、藏着的坑 */
  summary: (seed: string) => Record<string, unknown>;
}

export function realTask(def: RealTaskDef): EvalTask {
  return {
    id: def.id,
    env: def.suite,
    suite: def.suite,
    difficulty: def.difficulty,
    title: def.title,
    domain: def.domain,
    create(seed: string): EvalWorld {
      return {
        seed,
        statement: () => def.statement(seed),
        completion: () => def.completion(seed),
        materials: () => def.materials(seed),
        starter: () => def.starter(seed),
        deliverables: () => [...def.deliverables],
        check: (dir, ctx) => def.check(dir, ctx, seed),
        summary: () => def.summary(seed),
      };
    },
    solve: def.solve,
    naive: def.naive,
  };
}

/** 题目目录下某个子目录里的全部文件：相对路径 → 内容（文本） */
export function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '__pycache__') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** 这个模块所在目录下的路径（题目文件和代码放在一起） */
export function here(metaUrl: string, ...parts: string[]): string {
  return join(dirname(fileURLToPath(metaUrl)), ...parts);
}

// ── 代码题：在沙箱里跑隐藏测试 ────────────────────────────────────────────

/** 隐藏测试放进交付的拷贝里的目录名（不会和 agent 自己的文件撞上） */
export const HIDDEN_DIR = '_melina_hidden_tests';

export interface UnitTestRun {
  ran: number;
  failed: string[]; // 挂了的测试名（失败和出错都算）
  ok: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
}

/** 检查环境里没有 python3 时命令只打这一行、退出码 97：跑分这边的问题，不算交付没过 */
const NO_PYTHON = 'MELINA_CHECK_NO_PYTHON3';

/**
 * 把交付拷一份，放进隐藏测试，在沙箱里跑 python3 -m unittest。交付里的 .git 不拷（检查不读历史，也免得拷大仓库）。
 * 检查本身跑不起来就抛错（没有沙箱、沙箱里没有 python3）：跑分记成出错，不算任务失败
 */
export async function runHiddenTests(
  dir: string,
  hidden: Record<string, string>,
  sandbox: Sandbox | undefined,
  opts: { timeoutMs?: number; domain?: string } = {},
): Promise<UnitTestRun> {
  if (!sandbox) throw new Error('这道题的检查要在沙箱里跑隐藏测试，跑分脚本没给沙箱');
  const scratch = mkdtempSync(join(tmpdir(), 'melina-eval-check-'));
  try {
    cpSync(dir, scratch, { recursive: true, filter: (src) => !src.split('/').includes('.git') });
    rmSync(join(scratch, HIDDEN_DIR), { recursive: true, force: true });
    writeFiles(join(scratch, HIDDEN_DIR), hidden);
    writeFileSync(join(scratch, HIDDEN_DIR, '__init__.py'), '');
    const r = await sandbox(
      scratch,
      // 工作目录就是这份拷贝：容器里是 /workspace（ContainerRuntime.exec 默认在这），宿主机上的沙箱是 dir 本身
      `command -v python3 >/dev/null 2>&1 || { echo ${NO_PYTHON}; exit 97; }; ` +
        `PYTHONDONTWRITEBYTECODE=1 timeout ${Math.ceil((opts.timeoutMs ?? 120_000) / 1000)} python3 -m unittest discover -s ${HIDDEN_DIR} -t . -v 2>&1`,
      { timeoutMs: (opts.timeoutMs ?? 120_000) + 30_000, domain: opts.domain ?? 'general' },
    );
    if (r.exitCode === 97 && r.output.trim() === NO_PYTHON) throw new Error('检查环境里没有 python3，隐藏测试跑不了');
    return parseUnittest(r.output, r.exitCode, r.timedOut);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** unittest -v 的输出：每个测试一行「name (module.Class.name) ... ok/FAIL/ERROR」，最后「Ran N tests」和 OK / FAILED */
export function parseUnittest(output: string, exitCode: number | null, timedOut: boolean): UnitTestRun {
  const ran = Number(/^Ran (\d+) tests?/m.exec(output)?.[1] ?? 0);
  const failed: string[] = [];
  for (const m of output.matchAll(/^(test\w*) \(([\w.]+)\)[^\n]*?\.\.\. (?:FAIL|ERROR)/gm)) failed.push(m[1] as string);
  for (const m of output.matchAll(/^(?:FAIL|ERROR): (test\w*) \(/gm)) {
    if (!failed.includes(m[1] as string)) failed.push(m[1] as string);
  }
  // 命令里的 timeout 先到点时退出码是 124（沙箱自己的计时器还没到）：一样算超时
  const timeUp = timedOut || exitCode === 124;
  const ok = !timeUp && exitCode === 0 && ran > 0 && /^OK\b/m.test(output) && failed.length === 0;
  return { ran, failed, ok, output, timedOut: timeUp, exitCode };
}

/**
 * 隐藏测试的结果写成一句话。超时、被杀、一个都没跑起来的标上 suspect：可能是交付的问题，也可能是检查环境慢、
 * 内存不够、起不来，跑分拿标准解在同一个沙箱里复跑来分
 */
export function testsSummary(r: UnitTestRun): CheckResult {
  if (r.timedOut) return { pass: false, summary: '隐藏测试跑超时了', suspect: '检查超时' };
  if (r.exitCode === 137 || /(^|\n)Killed\s*$/.test(r.output)) {
    return { pass: false, summary: `隐藏测试跑到一半被杀了（退出码 ${r.exitCode}）`, suspect: '检查被杀' };
  }
  if (r.ran === 0) {
    const tail = r.output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return { pass: false, summary: `隐藏测试一个都没跑起来：${tail}`, suspect: '一个测试都没跑起来' };
  }
  if (r.ok) return { pass: true, summary: `隐藏测试 ${r.ran} 个全过` };
  const shown = r.failed.slice(0, 6).join('、');
  return {
    pass: false,
    summary: `隐藏测试 ${r.ran} 个里挂了 ${r.failed.length} 个：${shown}${r.failed.length > 6 ? ' 等' : ''}`,
  };
}

// ── 研究题：读 answer.json ────────────────────────────────────────────────

/** 读交付里的 answer.json；读不到、不是对象都返回原因。开头带 UTF-8 BOM 的照收（RFC 8259 许解析时忽略） */
export function readAnswer(dir: string): { value: Record<string, unknown> } | { error: string } {
  const path = join(dir, 'answer.json');
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { error: 'answer.json 不是普通文件' };
    if (st.size > 1024 * 1024) return { error: 'answer.json 太大' };
    text = readFileSync(path, 'utf8');
  } catch {
    return { error: '工作目录里没有 answer.json' };
  }
  try {
    const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'answer.json 不是一个 JSON 对象' };
    return { value: v as Record<string, unknown> };
  } catch (e) {
    return { error: `answer.json 不是合法的 JSON：${(e as Error).message}` };
  }
}

/** 标准解和直接做法共用：把对象写成 answer.json */
export function writeAnswer(dir: string, answer: Record<string, unknown>): void {
  writeFileSync(join(dir, 'answer.json'), `${JSON.stringify(answer, null, 2)}\n`);
}

/** 研究题的完成标准里固定的两条：answer.json 的格式、report.md */
export function answerCriteria(fields: string): string[] {
  return [
    `在工作目录根下写 answer.json，字段：${fields}。`,
    '在工作目录根下写 report.md：结论、依据（看了哪些数据、怎么算的）、排除了哪些干扰。',
  ];
}

// ── 代码题的通用写法 ──────────────────────────────────────────────────────

export interface CodeTaskDef {
  id: string;
  difficulty: Difficulty;
  title: string;
  /** 题目目录：starter/（起点仓库）、hidden/（隐藏测试和它的数据）、solution/（标准解，盖在起点上）、naive/（直接的做法，盖在起点上） */
  dir: string;
  statement: string;
  completion: CompletionSpec;
  /** 真值、藏着的坑，只进存档 */
  notes: Record<string, unknown>;
  timeoutMs?: number;
}

export function codeTask(def: CodeTaskDef): EvalTask {
  const tree = (name: string) => readTree(join(def.dir, name));
  const overlay = (name: string) => async (ctx: SolveContext) => writeFiles(ctx.dir, tree(name));
  return realTask({
    id: def.id,
    suite: 'code',
    difficulty: def.difficulty,
    title: def.title,
    domain: 'code',
    statement: () => def.statement,
    completion: () => def.completion,
    starter: () => tree('starter'),
    materials: () => [],
    deliverables: [],
    check: async (dir, ctx) =>
      testsSummary(
        await runHiddenTests(dir, tree('hidden'), ctx.sandbox, {
          domain: 'code',
          ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
        }),
      ),
    solve: overlay('solution'),
    naive: overlay('naive'),
    summary: () => ({ hiddenTests: Object.keys(tree('hidden')), ...def.notes }),
  });
}
