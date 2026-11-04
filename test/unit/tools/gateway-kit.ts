// ToolGateway 测试用的环境：内存里的 RunStore、临时目录里的 Artifact store 和视图、命令在宿主机上真跑的容器运行时、真的脱敏。
// 分支、Scoper 各起一个「容器」，workspace 是临时目录。

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RUN_CONFIG, type RunConfigOverride, resolveRunConfig } from '../../../src/core/config.ts';
import { newId } from '../../../src/core/ids.ts';
import type { ContainerRef, ResolvedCredential } from '../../../src/core/interfaces/container.ts';
import type {
  CallerContext,
  ToolCall,
  ToolOutcome,
  ToolSession,
  ToolSessionOptions,
} from '../../../src/core/interfaces/gateway.ts';
import type { ToolUsageEntry } from '../../../src/core/interfaces/ledger.ts';
import type { Bet, BetDraft, Branch, CompletionSpec, Run } from '../../../src/core/types.ts';
import { MelinaToolGateway } from '../../../src/tools/gateway.ts';
import { SecretRedactor } from '../../../src/tools/redact.ts';
import type { GatewayDeps } from '../../../src/tools/session.ts';
import { ArtifactViews, place } from '../../../src/tools/views.ts';
import { MODEL, startBranch, type TestRunStore, testRunStore } from '../storage/kit.ts';
import { HostRuntime } from './host-runtime.ts';

export const SECRET: ResolvedCredential = {
  id: newId(),
  name: 'GitHub token',
  as: { env: 'GH_TOKEN' },
  value: 'ghp_s3cret_V4lue_0123456789',
};

export const COMPLETION: CompletionSpec = {
  interpretation: '让 search 模块的测试全部通过',
  criteria: ['npm test 全过', '没有改测试文件'],
};

export interface Kit {
  dir: string;
  runStore: TestRunStore;
  views: ArtifactViews;
  runtime: HostRuntime;
  redactor: SecretRedactor;
  ledger: ToolUsageEntry[];
  errors: string[];
  gateway: MelinaToolGateway;
  run: Run;
  cleanup(): void;
}

export function kit(
  opts: {
    statement?: string;
    config?: RunConfigOverride;
    completion?: CompletionSpec | false;
    deps?: Partial<GatewayDeps>;
  } = {},
): Kit {
  const dir = mkdtempSync(join(tmpdir(), 'melina-gw-'));
  const runStore = testRunStore({ artifacts: join(dir, 'artifacts') });
  const artifacts = runStore.artifacts;
  if (!artifacts) throw new Error('没有 Artifact store');
  const views = new ArtifactViews({ dataDir: join(dir, 'data'), artifacts });
  const redactor = new SecretRedactor();
  redactor.update([SECRET]);
  const runtime = new HostRuntime({ root: dir, redactor });
  const ledger: ToolUsageEntry[] = [];
  const errors: string[] = [];
  const gateway = new MelinaToolGateway({
    writer: runStore.writer,
    queries: runStore.queries,
    // 和进程入口一样接上事件总线：交候选时完成标准还在起草，提交工具等它定好
    bus: runStore.bus,
    artifacts,
    runtime,
    redactor,
    views,
    ledger: { tool: (e) => ledger.push(e) },
    domains: () => ['code', 'research', 'general'],
    onError: (error, what) => errors.push(`${what}：${error instanceof Error ? error.message : String(error)}`),
    fileTimeoutMs: 10_000,
    ...opts.deps,
  });
  const runId = newId();
  let run = runStore.writer.createRun({
    id: runId,
    goal: { statement: opts.statement ?? '修好 search 模块，让测试全过', constraints: [], materials: [] },
    workspace: { root: join(dir, 'root'), kind: 'dir-copy' },
    config: {
      ...resolveRunConfig(opts.config ?? {}, DEFAULT_RUN_CONFIG),
      bet0: { models: [MODEL] },
    },
    createdAt: '2026-10-02T00:00:00.000Z',
  });
  if (opts.completion !== false) {
    run = runStore.writer.draftCompletion(run.id, {
      completion: opts.completion ?? COMPLETION,
      constraints: [],
      domain: 'code',
    });
  }
  return {
    dir,
    runStore,
    views,
    runtime,
    redactor,
    ledger,
    errors,
    gateway,
    run,
    cleanup: () => {
      runStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface BranchKit {
  bet: Bet;
  branch: Branch;
  ws: string;
  container: ContainerRef;
}

/** 建一条在跑的分支，起它的「容器」：workspace 是临时目录 */
export async function branch(k: Kit, over: Partial<BetDraft> = {}): Promise<BranchKit> {
  const { bet, branch } = startBranch(k.runStore, k.run, over);
  const ws = join(k.dir, 'ws', branch.id);
  mkdirSync(ws, { recursive: true });
  const container = await k.runtime.start({
    name: `melina-${k.run.id}-${branch.id}`.toLowerCase(),
    domain: 'code',
    workspace: { host: ws, container: '/workspace', readOnly: false },
    artifactsDir: await k.views.ensure(k.views.branchDir(k.run.id, branch.id)),
    materialsDir: await materialsDir(k),
    credentials: [SECRET],
  });
  return { bet, branch, ws, container };
}

/** 附件目录：runtime按 Material.name 放硬链接，只读挂到 /melina/materials；这里照做 */
async function materialsDir(k: Kit): Promise<string> {
  const dir = join(k.dir, 'data', k.run.id, 'materials');
  mkdirSync(dir, { recursive: true });
  for (const m of k.run.goal.materials) {
    const target = join(dir, m.name);
    if (!existsSync(target)) await place(k.runStore.artifacts!.path(k.run.id, m.handle), target);
  }
  return dir;
}

const sessionKits = new WeakMap<ToolSession, Kit>();

/** 给这条分支开一次会话（一个 episode） */
export function openExplorer(k: Kit, b: BranchKit, options?: ToolSessionOptions): ToolSession {
  const current = k.runStore.queries.getBranch(b.branch.id) as Branch;
  const caller: CallerContext = {
    runId: k.run.id,
    role: 'explorer',
    branchId: current.id,
    episode: current.episode,
    snapshot: current.lastSnapshot,
    container: b.container,
    readOnly: false,
  };
  const session = k.gateway.open(caller, options);
  sessionKits.set(session, k);
  return session;
}

export interface Called extends ToolOutcome {
  /** 被 session.check 拦下了（没有执行） */
  blocked?: boolean;
  json?: Record<string, unknown>;
}

let callCounter = 0;

/** 像 pi 一样调一次工具：先 check（同一轮的全部调用），过了再执行 */
export async function call(
  session: ToolSession,
  name: string,
  args: unknown,
  opts: { turn?: { name: string; args: unknown }[]; signal?: AbortSignal } = {},
): Promise<Called> {
  callCounter++;
  const c: ToolCall = { id: `call-${callCounter}`, name, args };
  const turn: ToolCall[] = opts.turn
    ? opts.turn.map((t, i) => ({ id: `call-${callCounter}-${i}`, name: t.name, args: t.args }))
    : [c];
  if (opts.turn && !turn.some((t) => t.name === name)) turn.push(c);
  const reason = session.check(c, turn);
  if (reason !== undefined) return { content: reason, isError: true, blocked: true };
  const tool = session.tools.find((t) => t.spec.name === name);
  if (!tool) return { content: `没有工具 ${name}`, isError: true, blocked: true };
  const outcome = await tool.run(c, opts.signal ?? new AbortController().signal);
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(outcome.content);
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    // 不是 JSON（错误说明、收尾已接受）
  }
  return { ...outcome, ...(json ? { json } : {}) };
}

/** 交候选：spec 的 submit_candidate 并进了 end_episode 的 candidate。照旧写参数，这里拼成 end_episode 再调 */
export function submitCandidate(session: ToolSession, args: Record<string, unknown>): Promise<Called> {
  return call(session, 'end_episode', { candidate: args });
}

/** 执行命令并返回宿主持久化的观测 ID。 */
export async function sh(session: ToolSession, cmd: string, opts: { expect?: string } = {}): Promise<string> {
  const result = await call(session, 'sh', { cmd, ...opts });
  if (result.isError || !result.observationId) throw new Error(result.content);
  return result.observationId;
}
