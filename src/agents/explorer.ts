// 一条求解分支的持续会话；上下文到 70% 自动压缩，宿主只增开接力分支。
import type {
  EpisodeHandle,
  EpisodeOutcome,
  ExplorerAgent,
  RoleCallHandle,
  RoleCallResult,
  RoleCallRunner,
} from '../core/interfaces/agents.ts';
import type { CloseOutcome } from '../core/tools.ts';
export const COMPACT_RATIO = 0.7;
export const COMPACT_KEEP = 0.25;
export interface ExplorerDeps {
  runner: RoleCallRunner;
  onNotice?: (text: string) => void;
}
export function createExplorerAgent(deps: ExplorerDeps): ExplorerAgent {
  return {
    startEpisode(input): EpisodeHandle {
      const { run, branch, bet, session, layout, signal } = input;
      let seenSeq = layout.seenSeq ?? branch.seenSeq;
      let call: RoleCallHandle | undefined;
      call = deps.runner.start({
        meta: {
          runId: run.id,
          branchId: branch.id,
          role: 'explorer',
          job: 'explorer_episode',
          sessionId: branch.id,
          model: bet.model,
          signal,
        },
        layout,
        session,
        continueUntilClosed: true,
        closeReminder:
          '目标尚未全部完成就调用工具继续推进；全部完成及外部验收通过后调用 end_episode，填写 candidate；仅暂停或必要交接时填写 handoff。',
        compact: {
          ratio: COMPACT_RATIO,
          keep: COMPACT_KEEP,
          onCompacted: (info) => deps.onNotice?.(`分支 ${branch.id} 自动压缩：${info.before} → ${info.after} token`),
          onFailed: (error) => {
            deps.onNotice?.(`分支 ${branch.id} 压缩失败：${String(error)}`);
            call?.steer(
              '上下文压缩失败。请立即用 end_episode.handoff 保存关键进展、已控资产、下一步及恢复服务的方法，随后新会话继续。',
            );
          },
        },
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.referenceContext ? { referenceContext: input.referenceContext } : {}),
      });
      const handle = call;
      return {
        done: handle.done.then((result: RoleCallResult): EpisodeOutcome => {
          const base = { toolCalls: result.toolCalls, usage: result.usage, seenSeq };
          const out = result.outcome;
          if (out.kind === 'closed') return { ...base, close: out.args as CloseOutcome };
          if (out.kind === 'aborted') return base;
          return { ...base, failure: out.kind, ...(out.kind === 'model_error' ? detailOf(out.message) : {}) };
        }),
        ...(handle.handoffMaterial ? { handoffMaterial: handle.handoffMaterial } : {}),
        steer(text, seq) {
          if (seq !== undefined) seenSeq = Math.max(seenSeq, seq);
          handle.steer(text);
        },
      };
    },
  };
}
export function detailOf(message: string | undefined): { failureDetail?: string } {
  const text = (message ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\b(sk|pk|rk|key|tok)[-_][A-Za-z0-9_-]{6,}/gi, '$1-…')
    .slice(0, 240)
    .trim();
  return text ? { failureDetail: text } : {};
}
