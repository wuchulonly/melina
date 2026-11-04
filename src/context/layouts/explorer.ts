import { notFound } from '../../core/errors.ts';
import type { Id } from '../../core/ids.ts';
import type { ExplorerUpdate, Layout } from '../../core/interfaces/context.ts';
import type { RunStoreQueries } from '../../core/interfaces/store.ts';
import { explorerTools } from '../../core/tools.ts';
import type { Branch } from '../../core/types.ts';
import { bet0WatchEnabled } from '../../projections/bet0.ts';
import { latestWatch } from '../../projections/watch.ts';
import { goalSection, scoped } from '../render.ts';
import { watchMap as mapOf } from '../watch.ts';
import type { DomainInfo } from './scoper.ts';

export interface ExplorerSource {
  queries: RunStoreQueries;
  prompt: (name: 'explorer') => string;
  domains?: () => readonly DomainInfo[];
}
export function explorerLayout(src: ExplorerSource, branch: Branch): Layout {
  const run = src.queries.getRun(branch.runId);
  const bet = src.queries.getBet(branch.betId);
  if (!run || !bet) throw notFound('任务或路线不存在');
  const continuation = bet.continuation;
  const handoff = branch.handoff ?? continuation?.handoff;
  const inputs = src.queries.humanInputs(run.id);
  const inputIds = new Set(inputs.map((input) => input.id));
  const messages = [
    ...(handoff ? [`# 交接摘要\n\n${handoff}`] : []),
    ...(continuation
      ? [
          `# 本次方向\n\n${continuation.direction}\n\n工作区来自源路线的快照。容器是新建的；按摘要恢复服务、会话与依赖，再核对外部资产的当前状态。`,
        ]
      : []),
    ...(inputs.length ? [`# 追加指令与宿主回执\n\n${inputs.map((input) => input.text).join('\n\n')}`] : []),
    ...src.queries
      .inbox(branch.id, branch.seenSeq)
      .filter((item) => !item.ref || !inputIds.has(item.ref))
      .map((item) => item.text),
  ];
  return {
    role: 'explorer',
    system: [
      src.prompt('explorer'),
      goalSection(run, {
        readOnly: false,
        scoping: !scoped(src.queries, run.id),
        domainDescription: src.domains?.().find((d) => d.name === run.goal.domain)?.description,
      }),
    ].join('\n\n'),
    tools: explorerTools(),
    messages: [{ role: 'user', text: messages.join('\n\n') || '开始执行目标。' }],
    basedOnSeq: src.queries.lastSeq(),
    seenSeq: src.queries.lastSeq(),
  };
}
export function explorerUpdate(src: ExplorerSource, branch: Branch, sinceSeq: number): ExplorerUpdate | undefined {
  const items = src.queries.inbox(branch.id, sinceSeq);
  return items.length
    ? { text: items.map((item) => item.text).join('\n\n'), seenSeq: Math.max(...items.map((item) => item.seq)) }
    : undefined;
}
export function watchMap(src: ExplorerSource, branchId: Id): string | undefined {
  const branch = src.queries.getBranch(branchId);
  const run = branch && src.queries.getRun(branch.runId);
  if (!branch || !run || !bet0WatchEnabled(src.queries, run, branch.betId)) return undefined;
  const note = latestWatch(src.queries, run.id, branch.id);
  return mapOf(note) || undefined;
}
