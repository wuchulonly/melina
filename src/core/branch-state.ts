import type { EpisodeOutcomeKind } from './events.ts';
import type { BranchState } from './types.ts';
export interface CloseTransitionInput {
  outcome: EpisodeOutcomeKind;
  failures: number;
  maxFailures: number;
  pendingPause?: string;
  detail?: string;
  runPaused: boolean;
}
export interface CloseTransition {
  state: BranchState;
  stateNote?: string;
  failures: number;
  queued?: boolean;
}
export function closeTransition(input: CloseTransitionInput): CloseTransition {
  const failures = input.outcome === 'failed' ? input.failures + 1 : 0;
  if (input.outcome === 'submitted') return { state: 'succeeded', failures };
  if (failures >= input.maxFailures)
    return {
      state: 'failed',
      failures,
      stateNote: `连续 ${failures} 次会话失败${input.detail ? `：${input.detail}` : ''}`,
    };
  if (input.pendingPause !== undefined) return { state: 'paused', failures, stateNote: input.pendingPause };
  return { state: 'running', failures, ...(input.runPaused ? { queued: true } : {}) };
}
