// 布局必须是确定的：同一个 RunStore 版本产出逐字节相同的前缀，否则缓存失效。
// 只产出 Melina 自己的类型（Layout），由 agents/episode.ts 转成 Harness 消息。

import type { Handle, Id } from '../ids.ts';
import type { ToolSpec } from '../tools.ts';
import type { Branch, Role, Run, WatchNote } from '../types.ts';
import type { StoreRecord } from './store.ts';

export interface LayoutMessage {
  role: 'user';
  text: string;
}

/** 首屏与查询共用的冻结材料；宿主按摘要展示进度续读，不要求展开全文。 */
export interface WatchContext {
  records: readonly StoreRecord[];
  stateRefs: readonly Id[];
  /** 连续覆盖所需的历史序号；跨分支观测不计入本分支进度。 */
  history: readonly number[];
  covered: readonly number[];
  delivered: readonly Id[];
  /** 首屏折叠的人的要求，可按需展开。 */
  inspectContext: readonly string[];
}

export interface Layout {
  role: Role;
  system: string;
  /** 第 2 段：按角色的工具集，和 ToolSession.tools 的顺序一致 */
  tools: ToolSpec[];
  messages: LayoutMessage[];

  basedOnSeq: number;
  /** Explorer：这份上下文里分支消息看到了哪个 seq，正常收尾时写进 Branch.seenSeq */
  seenSeq?: number;
  /** 巡检器首屏对应的冻结记录和展示信息；messages 已是最终文本。 */
  watch?: WatchContext;
}

/** episode 正在跑时新到的内容，拼成一段追加到消息末尾（agent.steer，、） */
export interface ExplorerUpdate {
  text: string;
  /** 这段里最大的 seq；收尾时 seenSeq 取它 */
  seenSeq: number;
}

/**
 * 挑版：交过的几版各自的内容。RunStore 上只有句柄和 snapshot，原文由 runtime 先读好（ContextAssembler 只读 RunStore，
 * 不碰 workspace）；目标、标准、成果说明与人的追加要求由布局从 RunStore 拼。
 */
export interface PickRequest {
  /** 证据和用户附件的原文；终局函数无工具，宿主一次读好。 */
  sources?: { handle: Handle; text: string }[];
  /** 按交的先后：第 1 版是最先交的 */
  versions: {
    candidateId: Id;
    /** 交付物是单个文件时它的原文（Candidate.artifact） */
    artifact?: string;
    /** 这一版的工作目录相对起点的改动（patch）；交付物那个文件单独给了，这里不再重复；没改动是空串 */
    patch: string;
  }[];
}

/**
 * 巡检器的一轮：看哪条路线（主干直解路线）、看到 RunStore 的哪一刻为止，和它自己的上一版看法。
 * 这一轮新看到的是上一版的 basedOnSeq 之后、untilSeq 以前（含）的记录；第一轮从头看
 */
export interface WatchRequest {
  branchId: Id;
  /** 执行历史的冻结截止点，积压时可能早于最新 seq；最新状态使用独立边界。 */
  untilSeq: number;
  /** 最新状态独立冻结；refs 只开放提示、宿主状态和回执，不开放中间未读的执行历史。 */
  state?: {
    untilSeq: number;
    refs: Id[];
    activity?: Pick<Branch, 'toolCalls' | 'episode' | 'state' | 'queued'>;
    task?: Pick<Run, 'status' | 'mode'>;
  };
  /** 宿主采集后按此预算冻结窗口；积压和预算耗尽时缩窗。 */
  window?: { maxSteps: number; maxBytes: number };
  /** 上一版看法（第一轮没有） */
  previous?: WatchNote;
  /** 宿主刷新输入后，同一 RunStore 截止点的工具计数。 */
  toolCalls?: number;
  activity?: Pick<Branch, 'toolCalls' | 'episode' | 'state' | 'queued'>;
  /** 从本窗口原始工具产物抽出的 HTTP 材料；原文仍可按句柄读取。 */
  http?: { observation: Id; output: Handle; text: string }[];
}

/**
 * 巡检器地图的首尾标签：context/watch.ts 将最新地图包成一块，模型适配器作为独立参考材料提供。
 */
export const WATCH_MAP_TAG = 'melina-watch';

export interface ContextAssembler {
  forExplorer(branch: Branch): Layout;

  explorerUpdate(branch: Branch, sinceSeq: number): ExplorerUpdate | undefined;
  forScoper(run: Run): Layout;

  forSelection(runId: Id, request: PickRequest): Layout;

  forWatcher(runId: Id, request: WatchRequest): Layout;
  /**
   * 巡检器给主干直解路线的短地图：这条路线最新的一版看法编成的一块（WATCH_MAP_TAG 包着）；不是主干直解路线、
   * 还没有看法就是 undefined。按 branchId 现读，不接分支快照：它每次发请求前都调（RoleCallRequest.referenceContext），要那一刻最新的一版
   */
  watchMap(branchId: Id): string | undefined;
}
