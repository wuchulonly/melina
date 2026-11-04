import { DEFAULT_RUN_CONFIG } from '../../../src/core/config.ts';
import type { MelinaEvent, MelinaEventOf } from '../../../src/core/events.ts';
import { ROOT } from '../../../src/core/ids.ts';
import type { Bet, Branch, Run } from '../../../src/core/types.ts';
import { runSummary } from './project.ts';

export const MODELS = {
  strong: { provider: 'deepseek', model: 'deepseek-reasoner', tier: 'strong' as const },
  strongAlt: { provider: 'anthropic', model: 'claude-sonnet-4-5', tier: 'strong' as const },
  fast: { provider: 'deepseek', model: 'deepseek-chat', tier: 'fast' as const },
  fastAlt: { provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'fast' as const },
};
export interface RunScript {
  name: string;
  title: string;
  description: string;
  runIds: string[];
  events: MelinaEvent[];
  moments: { seq: number; label: string; runId: string; summary: ReturnType<typeof runSummary> }[];
  artifacts: Record<string, string>;
}
const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
export function allScripts(): RunScript[] {
  return [directScript(false), directScript(true)];
}
function directScript(fork: boolean): RunScript {
  const base = fork ? 100 : 0;
  const runId = id(base + 1);
  const events: MelinaEvent[] = [];
  const emit = <K extends MelinaEvent['type']>(type: K, data: MelinaEventOf<K>['data']) => {
    const seq = events.length + 1;
    events.push({ seq, runId, type, at: new Date(Date.UTC(2026, 9, 1, 9, 0, seq)).toISOString(), data } as MelinaEvent);
    return seq;
  };
  const run: Run = {
    id: runId,
    seq: 1,
    goal: {
      statement: fork ? '接力验证第二阶段' : '创建说明文档',
      constraints: [],
      materials: [],
      domain: 'code',
      completion: { interpretation: '写出说明并核对内容', criteria: ['answer.md 内容完整'] },
    },
    workspace: { root: '/home/me/api-server', kind: 'git-clone' },
    mode: 'direct',
    status: 'running',
    config: { ...structuredClone(DEFAULT_RUN_CONFIG), bet0: { models: [MODELS.strong, MODELS.strong, MODELS.strong] } },
    createdAt: new Date(Date.UTC(2026, 9, 1, 9)).toISOString(),
  };
  emit('run.created', run);
  const branches: Branch[] = [];
  for (let i = 0; i < 3; i++) {
    const bet: Bet = {
      id: id(base + 2 + i * 2),
      runId,
      seq: events.length + 1,
      kind: 'direct',
      label: `直解 ${i + 1}`,
      model: MODELS.strong,
      startFrom: { snapshot: ROOT },
      source: { kind: 'template' },
      status: 'active',
    };
    emit('bet.created', bet);
    const branch: Branch = {
      id: id(base + 3 + i * 2),
      runId,
      seq: events.length + 1,
      betId: bet.id,
      state: 'running',
      queued: false,
      lastSnapshot: ROOT,
      seenSeq: 1,
      episode: 1,
      toolCalls: 0,
      failures: 0,
      weight: 1,
    };
    branches.push(branch);
    emit('branch.created', branch);
  }
  const moment = (label: string) => ({ seq: events.length, label, runId, summary: runSummary(events, runId) });
  const moments = [moment('三路独立直解')];
  const first = branches[0]!;
  const handle = `art://${'ab'.repeat(32)}` as const;
  emit('observation.created', {
    id: id(base + 20),
    runId,
    seq: events.length + 1,
    branchId: first.id,
    episode: 1,
    role: 'explorer',
    tool: 'sh',
    args: { cmd: 'cat answer.md' },
    summary: '退出码 0；说明文档核对完成',
    output: handle,
    snapshot: ROOT,
    exitCode: 0,
  });
  if (fork) {
    const bet: Bet = {
      id: id(base + 21),
      runId,
      seq: events.length + 1,
      kind: 'direct',
      label: '接力 1',
      model: MODELS.strong,
      startFrom: { snapshot: ROOT },
      source: { kind: 'template' },
      status: 'active',
      diffFrom: { branchId: first.id, note: '继续第二阶段' },
      continuation: {
        key: 'progress:one',
        slot: 0,
        handoff: '已验证第一阶段，工作区留有入口说明。恢复服务后检查第二阶段。',
        direction: '验证新的访问路径',
      },
    };
    emit('bet.created', bet);
    emit('branch.created', {
      ...first,
      id: id(base + 22),
      betId: bet.id,
      seq: events.length + 1,
      toolCalls: 0,
      handoff: bet.continuation!.handoff,
    });
    moments.push(moment('摘要接力'));
  } else {
    const candidate = {
      id: id(base + 21),
      runId,
      seq: events.length + 1,
      branchId: first.id,
      snapshot: ROOT,
      claim: '说明文档已完成并核对',
      artifact: handle,
      artifactPath: 'answer.md',
    };
    emit('candidate.created', candidate);
    emit('branch.updated', { ...first, seq: events.length + 1, state: 'succeeded', toolCalls: 1 });
    emit('run.updated', {
      ...run,
      seq: events.length + 1,
      status: 'done',
      endedAt: new Date(Date.UTC(2026, 9, 1, 9, 1)).toISOString(),
      result: { candidateId: candidate.id, knowledgeReport: handle },
    });
    moments.push(moment('交付完成'));
  }
  return {
    name: fork ? 'summary-fork' : 'direct-code',
    title: run.goal.statement,
    description: fork ? '进展触发摘要接力' : '三路独立工作并交付',
    runIds: [runId],
    events,
    moments,
    artifacts: { [handle]: '# 说明\n已核对内容。\n' },
  };
}
