// Run 的创建与异步准备：起点、材料、初始求解分支、Scoper 补充及重启续接。
import { copyFile, link, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { bet0ModelsOf, RunConfig, resolveRunConfig } from '../core/config.ts';
import { conflict, invalid, MelinaError, notFound } from '../core/errors.ts';
import { type Handle, type Id, newId, ROOT } from '../core/ids.ts';
import type { CreateRunInput } from '../core/interfaces/runtime.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import { type ModelRef, sameModel } from '../core/model-ref.ts';
import type { Bet, Material, Run, RunWorkspace, ScoperOutput, WorkspaceRef } from '../core/types.ts';
import { check } from '../core/validate.ts';
import { initialBet0Bets } from '../projections/bet0.ts';
import { errorText, sleep } from './async.ts';
import { isTerminal } from './branch-manager.ts';
import { isEnded, type RunLifecycle, type RunManagerDeps } from './run-lifecycle.ts';
import { bet0Draft, bet0Label, CONTINUE_MATERIALS, literalScope, type ScopedNews, scopedNotice } from './templates.ts';

const DEFAULT_RETRY_DELAYS = [5_000, 30_000];

export class RunBootstrap {
  private readonly deps: RunManagerDeps;
  private readonly lifecycle: RunLifecycle;
  private readonly fail: (runId: Id, reason: string) => Promise<Run>;

  constructor(lifecycle: RunLifecycle, fail: (runId: Id, reason: string) => Promise<Run>) {
    this.lifecycle = lifecycle;
    this.deps = lifecycle.deps;
    this.fail = fail;
  }

  // ── 建 Run ────────────────────────────────────────

  async create(input: CreateRunInput): Promise<Run> {
    const { writer, queries: q, registry, paths } = this.deps;
    const statement = input.statement.trim();
    if (!statement) throw invalid('目标不能是空的');
    const domains = this.deps.config.global().domains;
    if (input.domain !== undefined && !domains.includes(input.domain)) {
      throw invalid(`没有这个领域：${input.domain}（可选：${domains.join('、')}）`);
    }
    if (input.domain !== undefined && input.completion === undefined) {
      throw invalid('domain 要和 completion 一起给；只给目标时由 Scoper 定');
    }
    const id = newId();

    // 接着做：上个任务要在、要已经结束；工作目录和交付方式照旧
    let prev: Run | undefined;
    if (input.continueFrom) {
      prev = q.getRun(input.continueFrom);
      if (!prev) throw notFound('要接着做的任务不存在：删掉的任务不能接着做');
      if (!isEnded(prev)) throw conflict('只能接着做已经结束的任务');
      if (input.workspace) throw invalid('接着做时不传工作目录，照上个任务的');
    }

    // 生效配置：默认值合并覆盖，档位换成具体的模型；模型页没配模型时这里就报出来
    const config = resolveRunConfig(input.config ?? {});
    config.bet0.models = this.bet0Models(config.bet0);
    if (config.continuation?.enabled && config.bet0.models.length > config.continuation.maxActive)
      throw invalid('初始 Bet 0 路数不能超过 continuation.maxActive');
    // 巡检器写了模型的同样换成具体的；没写的每轮现挑（agents/watcher.ts）。报错时说清是巡检器那一项
    if (config.watch?.model) {
      const choice = config.watch.model;
      try {
        config.watch.model = registry.resolve(choice);
      } catch (error) {
        throw new MelinaError(
          error instanceof MelinaError ? error.code : 'unavailable',
          `巡检器的模型：${errorText(error)}`,
        );
      }
    }
    check(RunConfig, config, '配置'); // 落文件之前先查，覆盖写错了不留半截
    const copies = config.bet0.models.length;
    if (config.watch?.disabledBet0Copies?.some((copy) => copy > copies))
      throw invalid(`watch.disabledBet0Copies 编号必须在 1–${copies} 之间`);

    // 工作目录和 provider
    let workspace: RunWorkspace;
    if (prev) {
      workspace = {
        root: prev.workspace.root,
        kind: prev.workspace.kind,
        from: { runId: prev.id, snapshot: startOf(q, prev) },
      };
    } else if (input.workspace) {
      const root = resolve(input.workspace);
      if (within(root, paths.dataDir)) throw invalid(`工作目录不能在 Melina 的数据目录里：${root}`);
      workspace = { root, kind: await this.deps.workspaces.detect(root) };
    } else {
      const root = paths.emptyRoot(id);
      await mkdir(root, { recursive: true });
      workspace = { root, kind: 'dir-copy' };
    }

    if (config.workspace.setup) workspace.setup = config.workspace.setup;
    const materials = await this.materials(id, input.materials, prev);
    const run = writer.createRun({
      id,
      goal: {
        statement,
        constraints: [],
        materials,
        // 给了完成标准（评估、API）也照样调 Scoper，完成标准、领域照给的用；领域没给的由 Scoper 选
        ...(input.completion ? { completion: input.completion } : {}),
        ...(input.domain ? { domain: input.domain } : {}),
      },
      workspace,
      ...(prev ? { continuedFrom: prev.id } : {}),
      config,
      createdAt: new Date(this.deps.clock.now()).toISOString(),
    });
    this.lifecycle.background(this.prepare(run.id));
    return run;
  }

  /**
   * 显式数组保留顺序和重复副本；档位先去重、筛选配了 key 的模型，再按 copies 循环分配。
   * 没有 copies 时每个可用模型一份；没有可用 key 时使用首选，建任务前由 missingKeys 拦下不可用的档位。
   */
  private bet0Models({ models: choice, copies }: RunConfig['bet0']): ModelRef[] {
    const { registry } = this.deps;
    const unique = (list: readonly ModelRef[]) => list.filter((m, i) => list.findIndex((x) => sameModel(x, m)) === i);
    if (Array.isArray(choice)) return [...choice];
    const listed = unique(registry.tier(choice.tier));
    const keyed = registry.apiKey ? listed.filter((m) => registry.apiKey?.(m.provider)) : listed;
    const selected = keyed.length > 0 ? keyed : [registry.resolve(choice)];
    return Array.from({ length: copies ?? selected.length }, (_, i) => selected[i % selected.length] as ModelRef);
  }

  /**
   * 附件：人上传的按原文件名（只取文件名，重名的加序号）；接着做时再带上上个任务的附件、知识报告，
   * 和没提交候选就结束时那份没做完的 patch，都复制进新 Run 的 Artifact store（上个任务以后删了也不影响）。
   */
  private async materials(runId: Id, uploads: CreateRunInput['materials'], prev: Run | undefined): Promise<Material[]> {
    const { artifacts } = this.deps;
    const used = new Set<string>();
    const out: Material[] = [];
    const add = (name: string, handle: Handle) => out.push({ name: uniqueName(name, used), handle });
    for (const m of uploads) add(cleanName(m.name || basename(m.path)), await artifacts.putFile(runId, m.path));
    if (prev) {
      for (const m of prev.goal.materials) add(m.name, await artifacts.copy(prev.id, m.handle, runId));
      const result = prev.result;
      if (result?.knowledgeReport) {
        add(CONTINUE_MATERIALS.knowledgeReport, await artifacts.copy(prev.id, result.knowledgeReport, runId));
      }
      if (result?.patch && !result.candidateId) {
        add(CONTINUE_MATERIALS.unfinishedPatch, await artifacts.copy(prev.id, result.patch, runId));
      }
    }
    return out;
  }

  /**
   * 后台准备根 snapshot、附件目录、初始求解分支和 Scoper；缺哪步做哪步，崩溃后能接着做。
   * 根 snapshot 就绪后先启动求解分支，再调 Scoper；提交候选时才等待完成标准。
   * 同一个 Run 一次只准备一遍；等待 Scoper 时不拿这个 Run 的锁（人照样能暂停、取消），建分支时才拿，
   * 免得和结束（取消、放弃）交错，开出没人收的分支。
   */
  prepare(runId: Id): Promise<void> {
    return this.lifecycle.locks.run(`prepare:${runId}`, async () => {
      const { queries: q } = this.deps;
      const signal = this.deps.scopes.signal(runId);
      const live = () => {
        const r = q.getRun(runId);
        return r && !isEnded(r) && !signal.aborted ? r : undefined;
      };
      let run = live();
      if (!run) return;
      try {
        await this.deps.workspaces.forRun(run).init(run);
        await this.linkMaterials(run);
        await this.registerSecrets(run);
        await this.lifecycle.locks.run(runId, async () => {
          run = live();
          if (run) await this.openTemplates(run);
        });
        // 预设完成标准时仍调用 Scoper，补充约束、共用系统、开题画像及未给定的领域和准备命令。
        run = live();
        if (run && scoperPending(q, run)) await this.scope(run, signal);
      } catch (error) {
        if (!live()) return;
        this.deps.log?.(`任务 ${runId} 准备时出错：${errorText(error)}`);
        // 转 failed 也可能写不进去：那时后台在重试（commit），这里记一笔就行，不能让准备整个抛出去没人接（恢复时是 void 调的）
        await this.fail(runId, `准备任务时出错：${errorText(error)}`).catch((e: unknown) =>
          this.deps.log?.(`任务 ${runId} 准备出错后转 failed 没写进去：${errorText(e)}`),
        );
      }
    });
  }

  /**
   * 工作目录里被忽略的小文件（.env 这类，init 刚抄进来）、普通目录里像放密钥的文件、附件：里面像密钥的值登记进打码表，
   * Scoper 和求解分支的输出里就看不到原值。出错只记日志，不挡准备。
   */
  private async registerSecrets(run: Run): Promise<void> {
    if (!this.deps.secrets) return;
    try {
      const n = await this.deps.secrets.add(run);
      if (n > 0) this.deps.log?.(`任务 ${run.id} 的工作目录和附件里有 ${n} 个像密钥的值，已登记进打码表`);
    } catch (error) {
      this.deps.log?.(`任务 ${run.id} 登记工作目录里的密钥出错：${errorText(error)}`);
    }
  }

  /** 附件放进 <dataDir>/<runId>/materials/<name>：硬链接，跨文件系统就复制；容器只读挂到 /melina/materials */
  private async linkMaterials(run: Run): Promise<void> {
    if (run.goal.materials.length === 0) return;
    const dir = this.deps.paths.materials(run.id);
    await mkdir(dir, { recursive: true });
    for (const m of run.goal.materials) {
      const target = join(dir, m.name);
      const source = this.deps.artifacts.path(run.id, m.handle);
      try {
        await link(source, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (code === 'EXDEV' || code === 'EPERM') await copyFile(source, target);
        else throw error;
      }
    }
  }

  /**
   * Scoper：只读容器挂起点，一次调用起草完成标准、约束、领域，不等人确认。建任务时给了完成标准的，它照抄那份、
   * 只补约束和领域等环境信息（RunStore 落库时完成标准照给的用，）。
   * 起草完补给已经在跑的路线（supplement）。
   * 模型的回复用不了时 Scoper 自己降级；这里只处理系统出错（容器起不来这类）：重试，还不行时主干直解路线已经在干活就
   * 按字面理解目标，不然任务转 failed。
   */
  private async scope(run: Run, signal: AbortSignal): Promise<void> {
    const { workspaces, env, assembler, gateway, scoper, writer, queries: q } = this.deps;
    const provider = workspaces.forRun(run);
    // 起点：没接着做就是工作目录本身；接着做时从根 snapshot 建一个副本
    const temp: WorkspaceRef | undefined = run.workspace.from ? await provider.create(ROOT) : undefined;
    const ws: WorkspaceRef = temp ?? { path: run.workspace.root };
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const container = await env.scoper(run, ws.path);
          const layout = assembler.forScoper(run);
          const session = gateway.open({
            runId: run.id,
            role: 'scoper',
            snapshot: ROOT,
            ...(container ? { container } : {}),
            workspace: ws,
            readOnly: true,
          });
          const outcome = await scoper.scope({ run, layout, session, signal });
          if (outcome.degraded) this.deps.log?.(`任务 ${run.id} 的 Scoper 降级了：按字面理解目标`);
          const drafted = writer.draftCompletion(run.id, this.normalizeScope(outcome.output));
          this.supplement(drafted, {
            // 建任务时就给了的完成标准开跑时已经在上下文里，只补这次才起草出来的
            ...(run.goal.completion === undefined && drafted.goal.completion
              ? { completion: drafted.goal.completion }
              : {}),
            ...((run.goal.domain ?? 'general') !== drafted.goal.domain ? { domain: drafted.goal.domain } : {}),
          });
          return;
        } catch (error) {
          if (signal.aborted) throw error;
          const now = q.getRun(run.id);
          if (now && !scoperPending(q, now)) return; // 已经起草过（并发、重来）
          const delay = delays[attempt];
          if (delay === undefined) {
            // 已有分支成功调用环境工具时，Scoper 启动失败后按字面理解目标降级，保留正在进行的工作。
            // 尚无分支成功调用工具时，视为准备失败，转 failed 并说明原因。
            if (!now || !this.working(now)) throw error;
            this.deps.log?.(
              `任务 ${run.id} 的 Scoper 起不来（${errorText(error)}），主干直解路线已经在干活：按字面理解目标`,
            );
            const out = literalScope(now.goal.statement, this.deps.config.global().domains);
            const drafted = writer.draftCompletion(run.id, out);
            this.supplement(
              drafted,
              run.goal.completion === undefined && drafted.goal.completion
                ? { completion: drafted.goal.completion }
                : {},
            );
            return;
          }
          this.deps.log?.(`任务 ${run.id} 的 Scoper 出错，${delay} 毫秒后再试：${errorText(error)}`);
          await sleep(this.deps.clock, delay, signal);
        } finally {
          await env.removeScoper(run.id);
        }
      }
    } finally {
      if (temp) await provider.dispose(temp).catch(() => {});
    }
  }

  /** 领域只能是配置里有的；不认识的按拿不准算，用 general */
  private normalizeScope(out: ScoperOutput): ScoperOutput {
    const domains = this.deps.config.global().domains;
    return domains.includes(out.domain)
      ? out
      : { ...out, domain: domains.includes('general') ? 'general' : (domains[0] ?? 'general') };
  }

  /**
   * Scoper 起草完：它定下的补给还没结束的路线，一条路线一条 notice。正在跑的 episode 由 Courier 立即追加，
   * 没在跑的下个 episode 在收件箱里看到（那时上下文里也有完成标准了，多看一遍不要紧）。
   * workspace 创建时尚未定下 setup 的，通知分支补跑准备命令。收尾中、已经结束的任务不用补。
   */
  private supplement(run: Run, drafted: Pick<ScopedNews, 'completion' | 'domain'>): void {
    const { queries: q, writer } = this.deps;
    if (isEnded(run) || run.mode === 'settling') return;
    for (const b of q.listBranches(run.id)) {
      if (isTerminal(b.state)) continue;
      const bet = q.getBet(b.betId);
      if (!bet) continue;
      const setup = b.workspace && !b.workspace.setup ? run.workspace.setup : undefined;
      const text = scopedNotice({
        ...(drafted.domain && b.workspace ? { domain: drafted.domain } : {}),
        ...(drafted.completion ? { completion: drafted.completion } : {}),
        constraints: run.goal.constraints,
        ...(run.goal.sharedSystems ? { sharedSystems: run.goal.sharedSystems } : {}),
        ...(setup ? { setup } : {}),
      });
      if (!text) continue;
      try {
        writer.appendInbox({ runId: run.id, branchId: b.id, kind: 'notice', text });
      } catch (error) {
        this.deps.log?.(`给分支 ${b.id} 补完成标准出错：${errorText(error)}`);
      }
    }
  }

  /** 主干直解路线在干活：有一份还没结束、调成过环境工具（容器起得来、命令跑得通） */
  private working(run: Run): boolean {
    return this.deps.queries.listBranches(run.id).some((b) => !isTerminal(b.state) && b.toolCalls > 0);
  }

  /**
   * 先创建初始路线记录，再逐条启动分支；已有记录和分支不重复创建。
   * 按模型及副本数量匹配已有路线，中途崩溃后只补开缺少的分支。
   */
  private async openTemplates(run: Run): Promise<void> {
    const { writer, queries: q, branches } = this.deps;
    const bets = q.listBets(run.id);
    const all = q.listBranches(run.id);
    // 建 Run 时已经换成具体的模型；没经过建 Run 的配置（测试里直接写库的）还是档位，这时现换
    const resolved = bet0ModelsOf(run.config);
    const models = resolved.length > 0 ? resolved : this.bet0Models(run.config.bet0);
    const unused = initialBet0Bets(bets);
    const copies = models.map((model, index) => {
      const found = unused.findIndex((b) => sameModel(b.model, model));
      if (found >= 0) return unused.splice(found, 1)[0] as Bet;
      const repeated = models.filter((m) => sameModel(m, model)).length > 1;
      const copy = models.slice(0, index + 1).filter((m) => sameModel(m, model)).length;
      return writer.createBet({
        ...bet0Draft(model, `${bet0Label(model, models)}${repeated ? ` · ${copy}` : ''}`),
        runId: run.id,
        source: { kind: 'template' },
      });
    });
    for (const bet of copies) {
      if (!all.some((b) => b.betId === bet.id)) await branches.apply({ kind: 'open', runId: run.id, bet });
    }
  }
}

/** 判断 Scoper 或初始求解分支是否尚未准备齐全，供重启后补齐。 */
export function preparationPending(q: RunStoreQueries, run: Run): boolean {
  const bets = q.listBets(run.id);
  const all = q.listBranches(run.id);
  const opened = (bet: Bet | undefined) => !!bet && all.some((b) => b.betId === bet.id);
  // 按 config.bet0.models 逐项匹配初始路线，保留重复模型的份数；中途崩溃后补开缺少的分支。
  const initial = initialBet0Bets(bets);
  const unused = [...initial];
  const copiesMissing =
    !opened(initial[0]) ||
    (run.mode !== 'settling' &&
      bet0ModelsOf(run.config).some((m) => {
        const index = unused.findIndex((b) => sameModel(b.model, m));
        return index < 0 || !opened(unused.splice(index, 1)[0]);
      }));
  return scoperPending(q, run) || copiesMissing;
}

/**
 * 以 completion.drafted 判断 Scoper 是否起草完成，降级也会写该事件。
 * 预设完成标准和已启动求解分支均不代表起草完成；未记录事件时重启会补调 Scoper，补齐约束等信息。
 * 收尾中的任务已有候选，不再起草。
 */
export function scoperPending(q: RunStoreQueries, run: Run): boolean {
  if (run.mode === 'settling') return false;
  return q.events({ since: 0, runId: run.id, types: ['completion.drafted'], limit: 1 }).length === 0;
}

/** 接着做的起点：交付了候选或一版的从它的 snapshot 起，什么都没交的从上个任务的起点起 */
function startOf(q: RunStoreQueries, prev: Run): string {
  const candidateId = prev.result?.candidateId;
  if (candidateId) {
    const c = q.candidates(prev.id).find((x) => x.id === candidateId);
    if (c) return c.snapshot;
  }
  return ROOT;
}

function within(path: string, dir: string): boolean {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d + sep);
}

/** 只取文件名，去掉路径分隔符和控制字符；空的叫「附件」 */
function cleanName(name: string): string {
  const base = [...basename(name.replaceAll('\\', '/'))]
    .filter((ch) => ch !== '/' && (ch.codePointAt(0) ?? 0) >= 0x20)
    .join('')
    .trim();
  return base && base !== '.' && base !== '..' ? base : '附件';
}

/** 重名的加序号：报告.md、报告 (2).md、报告 (3).md */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; used.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate);
  return candidate;
}
