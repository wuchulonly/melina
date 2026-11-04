// 任务停止、各分支不再提交版本后，比较已有交付物、改动、声明、观测与人类输入，选择交付版本。
// 选择结果记录为 version.picked；模型出错或超时沿用已有选择，没有选择时使用最早保存的版本。
// 使用 strong 档首选模型。选择仅响应 Melina 退出信号，另有超时限制；任务停止流程等待选择完成。

import { type Id, ROOT } from '../core/ids.ts';
import type { SelectVersion } from '../core/interfaces/agents.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { PickRequest } from '../core/interfaces/context.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import type { RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { WorkspaceProviders } from '../core/interfaces/workspace.ts';
import type { ModelRef } from '../core/model-ref.ts';
import type { Candidate, Run } from '../core/types.ts';
import { currentVersion, picksOf } from '../projections/versions.ts';
import { type Clock, errorText, realClock, untilAborted } from './async.ts';

/**
 * 一次挑版最多等多久。没有环境工具，一般几十秒；读得多、想得久的几分钟。再久多半是卡住了：任务停下时要等它，不能一直等
 */
export const PICK_TIMEOUT_MS = 5 * 60_000;

export interface VersionPicksDeps {
  queries: RunStoreQueries;
  writer: Pick<RunStoreWriter, 'recordPick'>;
  artifacts: Pick<ArtifactStore, 'read'>;
  workspaces: WorkspaceProviders;
  /** 没接上就不挑：交付的一直是最先存的那一版 */
  selectVersion?: SelectVersion | undefined;
  registry: Pick<ModelRegistry, 'resolve'>;
  clock?: Clock;
  /** 一次挑版的时限，默认 PICK_TIMEOUT_MS；测试里调短 */
  timeoutMs?: number;
  log?: (text: string) => void;
}

type Version = PickRequest['versions'][number];

export class VersionPicks {
  readonly #deps: VersionPicksDeps;
  readonly #clock: Clock;
  /** 在途的挑版（测试等它们做完） */
  readonly #inflight = new Set<Promise<void>>();
  #stopping = new AbortController();

  constructor(deps: VersionPicksDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? realClock;
  }

  /** 开始调度时（Melina 起来以后）：上次 stop 过的重新能挑 */
  start(): void {
    if (this.#stopping.signal.aborted) this.#stopping = new AbortController();
  }

  /** Melina 退出：在途的挑版作废（任务停下没写完的，重启后照 的语义处理） */
  stop(): void {
    this.#stopping.abort();
  }

  /**
   * 任务停下前（RunManager.finish，分支都已经停下、不会再交新的一版）：交过两版以上就用这一刻的全部记录挑一次。
   * 返回交付哪一版：挑中的那一版；没挑成是以前挑中的，一次都没挑成就是最先存的那一版；没交过一版是 undefined
   */
  async settle(runId: Id): Promise<Candidate | undefined> {
    const work = this.#pickOnce(runId).catch((error: unknown) => {
      if (this.#stopping.signal.aborted) return;
      this.#deps.log?.(`任务 ${runId} 挑版没挑成，交付的还是以前定下的那一版：${errorText(error)}`);
    });
    this.#inflight.add(work);
    try {
      await work;
    } finally {
      this.#inflight.delete(work);
    }
    const q = this.#deps.queries;
    return currentVersion(q.candidates(runId), picksOf(q, runId));
  }

  /** 在途的都结束（测试用） */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  async #pickOnce(runId: Id): Promise<void> {
    const { queries: q, selectVersion } = this.#deps;
    const run = q.getRun(runId);
    // 进了收尾（有路线交了候选）的交付的是候选，不用挑
    if (!run || run.mode === 'settling' || !selectVersion) return;
    const versions = q
      .candidates(runId)
      .filter((c) => c.interim)
      .sort((a, b) => a.seq - b.seq);
    if (versions.length < 2) return;
    let model: ModelRef;
    try {
      model = this.#deps.registry.resolve({ tier: 'strong' });
    } catch (error) {
      throw new Error(`没有可用的 strong 模型：${errorText(error)}`);
    }
    if (this.#stopping.signal.aborted) return;
    const signal = AbortSignal.any([
      this.#stopping.signal,
      AbortSignal.timeout(this.#deps.timeoutMs ?? PICK_TIMEOUT_MS),
    ]);
    const started = this.#clock.now();
    const [contents, sources] = await untilAborted(
      Promise.all([Promise.all(versions.map((c) => this.#content(run, c))), this.#sources(run)]),
      signal,
    );
    signal.throwIfAborted();
    const request: PickRequest = { versions: contents, sources };
    const result = await untilAborted(selectVersion({ run, request, model, signal }), signal);
    signal.throwIfAborted();
    this.#deps.writer.recordPick(runId, {
      candidateId: result.candidateId,
      versions: versions.map((c) => c.id),
      why: result.why,
      model,
      basedOnSeq: result.basedOnSeq,
    });
    const n = versions.findIndex((c) => c.id === result.candidateId) + 1;
    const seconds = Math.round((this.#clock.now() - started) / 1000);
    this.#deps.log?.(`任务 ${runId} 挑版：${versions.length} 版里挑了第 ${n} 版（用了 ${seconds} 秒）`);
  }

  /** 一次读齐用户附件，终局生成无需查询工具。 */
  async #sources(run: Run): Promise<NonNullable<PickRequest['sources']>> {
    const handles = new Set(run.goal.materials.map((m) => m.handle));
    return Promise.all(
      [...handles].map(async (handle) => {
        try {
          return { handle, text: textOf(await this.#deps.artifacts.read(run.id, handle)) };
        } catch (error) {
          return { handle, text: `（读不到原文：${errorText(error)}）` };
        }
      }),
    );
  }

  /** 一版的内容：交付物原文，和工作目录相对起点的改动（去掉交付物那个文件）。读不到的照实写，不挡挑版 */
  async #content(run: Run, c: Candidate): Promise<Version> {
    const { artifacts, workspaces } = this.#deps;
    let artifact: string | undefined;
    if (c.artifact) {
      try {
        artifact = textOf(await artifacts.read(run.id, c.artifact));
      } catch (error) {
        this.#deps.log?.(`挑版读不到第 ${c.id} 版的交付物：${errorText(error)}`);
      }
    }
    let patch: string;
    try {
      const handle = await workspaces.forRun(run).diffSnapshots(ROOT, c.snapshot);
      patch = textOf(await artifacts.read(run.id, handle));
      if (c.artifactPath) patch = withoutFile(patch, c.artifactPath);
    } catch (error) {
      patch = `（读不到这一版的改动：${errorText(error)}）`;
    }
    return { candidateId: c.id, ...(artifact !== undefined ? { artifact } : {}), patch };
  }
}

/** 文本照原样；含 NUL 的当成二进制，只写大小 */
function textOf(bytes: Uint8Array): string {
  if (bytes.includes(0)) return `（二进制内容，${bytes.length} 字节）`;
  return new TextDecoder().decode(bytes);
}

/**
 * patch 里去掉某个文件的那一段（交付物单独给了原文，不重复）：按「diff --git a/… b/…」分段，
 * 段头里是这个路径的整段去掉；去不掉（格式不认识）就原样留着
 */
export function withoutFile(patch: string, path: string): string {
  const clean = path.replace(/^\.?\//, '');
  const parts = patch.split(/^(?=diff --git )/m);
  return parts
    .filter((part) => {
      const head = part.split('\n', 1)[0] ?? '';
      if (!head.startsWith('diff --git ')) return true;
      return !(head.endsWith(` b/${clean}`) || head.includes(` a/${clean} `));
    })
    .join('');
}
