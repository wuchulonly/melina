// 这些字会进 Explorer 的上下文、显示在工作台页上，所以都写人话，不写内部编号（项目规范「写给人看」）。

import { ROOT } from '../core/ids.ts';
import { type ModelRef, modelKey } from '../core/model-ref.ts';
import type { BetDraft, CompletionSpec, ScoperOutput } from '../core/types.ts';

/** 主干直解路线的路线名；开了几份的后面带上各自的模型（bet0Label） */
export const BET0_LABEL = '主干直解路线';

/**
 * 主干直解路线不等 Scoper 完成即可开始执行；Scoper 随后补充完成标准与约束。
 * 每个选定模型创建独立路线，路线名标明模型；路线自行安排步骤并持续推进目标。
 */
export function bet0Draft(model: ModelRef, label = BET0_LABEL): BetDraft {
  return {
    kind: 'direct',
    label,
    startFrom: { snapshot: ROOT },
    model,
  };
}

export function bet0Label(model: ModelRef, all: readonly ModelRef[]): string {
  if (all.length <= 1) return BET0_LABEL;
  const clash = all.filter((m) => m.model === model.model).length > 1;
  return `${BET0_LABEL}（${clash ? modelKey(model) : model.model}）`;
}

/** 接着做时复制进新 Run 的附件名 */
export const CONTINUE_MATERIALS = {
  knowledgeReport: '知识报告.md',
  unfinishedPatch: '没做完的改动.patch',
} as const;

// ── 通过 agent.steer 追加到当前会话的提示 ──────────

export function pauseHint(reason: string): string {
  return `请先停下这条路线：${reason}。做完手头这一步就调用 end_episode 收尾，写清交接摘要。`;
}

/**
 * 准备工作目录、根 snapshot 和附件时尚无求解分支，暂不接收追加指令；前端置灰时显示同一句。
 * 求解分支启动后即可接收指令，无需等待 Scoper 起草完成。
 */
export const HINT_NOT_YET = '任务还在准备（正在准备工作目录），等它开始做了再追加指令';

/** 人暂停了整个任务 */
export const RUN_PAUSE_HINT =
  '人暂停了整个任务。做完手头这一步就按工具协议调用 end_episode 保存交接；任务恢复后会接着做。';

// ── 收件箱里 runtime 的提示（InboxItem 的 notice） ─────────────────────

/** 任务恢复后，每条分支收到一条；和剧本里的说法一致 */
export const RESUMED_NOTICE = '任务暂停过，后台进程已经停了，需要的话重新启动';

/** Scoper 起草完时补给一条路线的（scopedNotice） */
export interface ScopedNews {
  /** 这次才起草出来的完成标准；建任务时就给了的，开跑时已经在上下文里，不重复 */
  completion?: CompletionSpec;
  constraints: readonly string[];
  sharedSystems?: readonly string[];
  /** 建 workspace 后要跑的命令：这条路线的 workspace 建的时候还没有它，没跑过 */
  setup?: string;
  /** 已经开跑后才选定的领域，与启动时的 general 不同 */
  domain?: string;
}

/** Scoper 补充通知的首行。 */
export const SCOPED_NOTICE_HEAD = '开跑时还没定下的这些，Scoper 起草完补给你：';

/**
 * Scoper 起草完成后补充求解分支尚未收到的信息（收件箱的 notice，正在跑的 episode 由 Courier 立即追加）。
 * 完成标准写全，最终候选的 claim 说明实际完成内容和验证结果；约束、共用的外部系统照 Scoper 整理的写。
 * 没有一样是新的就是 undefined，不发
 */
export function scopedNotice(news: ScopedNews): string | undefined {
  const parts: string[] = [];
  if (news.domain) {
    parts.push(
      `领域定为 ${news.domain}。下一轮开始时使用该领域的镜像；工作区文件保留，旧容器的临时文件、后台进程和另装的依赖不保留。需要延续的内容先存进工作区。`,
    );
  }
  const c = news.completion;
  if (c) {
    const lines = [`完成标准定好了（Scoper 起草的，之后不再改）。对目标的理解：${c.interpretation}`];
    c.criteria.forEach((text, i) => {
      lines.push(`${i + 1}. ${text}`);
    });
    const m = c.metric;
    if (m) {
      const unit = m.unit ? `，单位 ${m.unit}` : '';
      const better = m.better === 'lower' ? '越小越好' : '越大越好';
      lines.push(`主指标：${m.name}${unit}，${better}，目标 ${plainNumber(m.target)}。交接和交付时写清实际测量结果。`);
    }
    lines.push(
      '全部完成标准及任务要求的外部验收通过后再交最终结果，用 end_episode.candidate 的 claim 写清实际完成内容和验证结果，单个交付文件可附 artifact 路径。用 deliver 保存阶段成果时，claim 写清成果和缺口。',
    );
    parts.push(lines.join('\n'));
  }
  if (news.constraints.length > 0) parts.push(`约束（不许做的事）：${news.constraints.join('；')}。`);
  if (news.sharedSystems && news.sharedSystems.length > 0) {
    parts.push(
      `共用的外部系统：${news.sharedSystems.join('、')}。它们没法复制，别的路线也可能在改，workspace 的 snapshot 也恢复不了；对它们动手前，先在 workspace 里把路线走通。`,
    );
  }

  if (news.setup?.trim()) {
    parts.push(
      `建 workspace 后要跑的准备命令是：${news.setup.trim()}。你的 workspace 建的时候还没有它，没跑过；还没装依赖就自己跑一遍。`,
    );
  }
  return parts.length > 0 ? [SCOPED_NOTICE_HEAD, ...parts].join('\n\n') : undefined;
}

/**
 * Scoper 系统出错、重试后仍无法启动，求解分支已在工作：照 Scoper 降级的写法定标准（目标原文当唯一的完成条目，
 * 和 agents/scoper.ts 的 degraded 一样），不让整个任务失败
 */
export function literalScope(statement: string, domains: readonly string[]): ScoperOutput {
  const domain = domains.includes('general') ? 'general' : (domains[0] ?? 'general');
  return { completion: { interpretation: '按字面理解', criteria: [statement] }, constraints: [], domain };
}

/** 整数照写，小数去掉浮点误差（和上下文里主指标的写法一样） */
function plainNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(10)));
}

/** 上个 episode 没有合法收尾：照样打了 snapshot，workspace 里的改动留着 */
export function failedEpisodeNotice(why: string): string {
  return `上个会话没有正常收尾（${why}），workspace 里可能有未写进交接的改动，先核对。`;
}

export const FAILURE_WHY = {
  model_error: '模型的回复用不了',
  no_close: '停下了却没调用收尾工具',
  context_overflow: '上下文撑爆了模型窗口',
} as const;

/** 崩溃后恢复：在途的 episode 丢掉了，workspace 回到上次收尾时 */
export const RECOVERED_NOTICE =
  'Melina 重启过：上个 episode 没做完就丢掉了，workspace 已经回到上次收尾时的样子，后台进程也停了，需要的话重新启动。';

/** 只有意图、没有结果的 sh 调用：不自动重放，由 Explorer 先查清 */
export function unknownCommandNotice(cmd: string, expect?: string): string {
  return `Melina 上次在执行下面这条命令时中断了，不知道它有没有生效：\n${cmd}\n${expect ? `当时的预期：${expect}\n` : ''}先查清它到底执行了没有，再决定要不要重做。`;
}

/** 建 workspace 后执行的 setup 命令失败了：不让分支失败，交给 Explorer 自己修 */
export function setupFailedNotice(setup: {
  cmd?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  tail?: string;
}): string {
  const how = setup.timedOut ? '超时了' : `退出码 ${setup.exitCode ?? '未知'}`;
  const cmd = setup.cmd ? `（${setup.cmd}）` : '';
  const tail = setup.tail?.trim() ? `\n输出的最后几行：\n${setup.tail.trim()}` : '';
  return `建 workspace 后执行的 setup 命令${cmd}失败了，${how}。${tail}\n先把环境修好再往下做，交接时写清恢复方式。`;
}

// ── 分支结束的原因（Branch.stateNote，工作台页的路线卡会显示） ──────────────

export const CANCEL_NOTES = {
  settling: '另一条路线先交了',
  cancelled: '你取消了任务',
  failed: '任务出错停下了',
} as const;

/** 人取消任务时的 Run.endReason */
export const CANCELLED_REASON = '你取消了任务';

/** 仓库类任务交付时没推成分支、只交了 patch：done 的 Run.endReason，结果页上显示 */
export const PATCH_ONLY_REASON =
  '改动没有推成你仓库里的分支，只交了 patch（在结果页下载）。你的仓库用了 git 的 filter（比如 git-crypt、LFS）时 Melina 不推分支，' +
  '免得把本该加密的明文、本该走 LFS 的大文件直接写进仓库；也可能是推的时候出了错。';

/**
 * 交付的改动里有像密钥的东西：pushes 是仓库类任务（本来要推分支）。where 是在哪几处，不含值
 */
export function leakedReason(where: readonly string[], pushes: boolean): string {
  const list = where.slice(0, 5).join('、') + (where.length > 5 ? ` 等 ${where.length} 处` : '');
  const head = pushes
    ? `交付的改动里有像密钥的东西（${list}），没推成你仓库里的分支，只交了 patch（在结果页下载），免得它们进了你的仓库。`
    : `交付的改动里有像密钥的东西（${list}）。`;
  return `${head}多半是干活时登录拿到的 token、抓下来的数据被写进了工作目录：用之前看一眼这些文件，不要的删掉。`;
}
