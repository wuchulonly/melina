// runtime 的几个组件：RunManager、BranchManager、Recovery。实现在 src/runtime/。

import type { CreateRunRequest, InputRequest, RunResultResponse } from '../api.ts';
import type { Handle, Id, SnapshotId } from '../ids.ts';
import type { Bet, Branch, HumanInput, Run, WorkspaceRef } from '../types.ts';
import type { EpisodeHandle, EpisodeOutcome } from './agents.ts';

// ── RunManager ────────────────────────────────────────────────────────────

/** 建 Run：HTTP 的 CreateRunRequest，加上已经落到本地的附件文件（multipart 上传的临时文件，或 SDK 给的本地路径） */
export interface CreateRunInput extends CreateRunRequest {
  materials: { name: string; path: string }[];
}

/**
 * 创建 Run、管理求解会话与任务状态，执行收尾：交付候选、生成知识报告。
 * 所有方法在状态不对时抛 MelinaError('conflict')，找不到抛 'not_found'。
 */
export interface RunManager {
  create(input: CreateRunInput): Promise<Run>;

  pause(runId: Id): Promise<Run>;

  interrupt?(runId: Id): Promise<Run>;
  /** 恢复：分支重新排队，每条分支的收件箱放一条「任务暂停过，后台进程已经停了」。 */
  resume(runId: Id): Promise<Run>;
  /**
   * 取消（暂停中的也能取消）：中止在途调用，交付知识报告和主路线停下时的 patch。放弃、出错也一样，最后用 RunStoreWriter.endRun
   * 一个事务结束：提交之前进程没了就等于没取消，重启后任务照常跑
   */
  cancel(runId: Id): Promise<Run>;

  input(runId: Id, req: InputRequest): Promise<HumanInput>;
  /** 删除已结束的 Run，连同 workspace、snapshot、Artifact 和 RunStore 记录；不动用户仓库里的 melina/<runId> 分支 */
  delete(runId: Id): Promise<void>;
  result(runId: Id): Promise<RunResultResponse>;
  /**
   * 进程启动、恢复跑完之后开始调度；退出时停下（在途作业作废，下次启动由恢复流程重来）。
   * 已经开始的取消、放弃、出错先结束完再停，人点的取消不因为退出 Melina 而丢掉
   */
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── BranchManager ─────────────────────────────────────────────────────────

/** 发给 BranchManager 的命令，串行应用；不合状态机的拒绝（conflict） */
export type BranchCommand =
  | { kind: 'open'; runId: Id; bet: Bet; parentBranchId?: Id } // 建分支：starting、queued，lastSnapshot 取 bet.startFrom.snapshot
  | { kind: 'started'; branchId: Id; workspace: WorkspaceRef } // 有容量了、workspace 建好：starting → running
  | { kind: 'queued'; branchId: Id; queued: boolean } // 开始或结束等容量
  | { kind: 'pause'; branchId: Id; reason: string }
  | { kind: 'resume'; branchId: Id } // paused → running，重新排队
  | { kind: 'prioritize'; branchId: Id; weight: number }
  | { kind: 'cancel'; branchId: Id }
  | { kind: 'fail'; branchId: Id; reason: string }; // 系统错误且无法恢复

export interface BranchManager {
  apply(command: BranchCommand): Promise<Branch>;

  closeEpisode(branch: Branch, outcome: EpisodeOutcome, snapshot: SnapshotId | undefined): Promise<Branch>;
  /** 登记、注销正在跑的 episode（branch-runner 用），kill 时中止它，steer 时追加给它 */
  attach(branchId: Id, episode: EpisodeHandle, abort: AbortController): void;
  detach(branchId: Id): void;

  steer(branchId: Id, text: string, seenSeq?: number): boolean;
}

// ── 崩溃恢复 ──────────────────────────────────────────────────────

export interface RecoveryReport {
  runs: Id[]; // 恢复的 Run（running 和 paused 的）
  branches: Id[]; // 回到 lastSnapshot 的分支
  unknownCommands: Id[]; // 只有意图、没有结果的 sh 调用：已往收件箱放提示，不自动重放
  rescoped: Id[]; // Scoper 没起草完、重新起草的 Run
}

export interface Recovery {
  run(): Promise<RecoveryReport>;
}

export interface KnowledgeReportWriter {
  write(runId: Id): Promise<{ report: Handle; patch?: Handle }>;
}
