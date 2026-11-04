import { createRoleCallRunner } from '../../../src/agents/episode.ts';
import { createExplorerAgent } from '../../../src/agents/explorer.ts';
import { createScoperAgent } from '../../../src/agents/scoper.ts';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { newId, type SnapshotId } from '../../../src/core/ids.ts';
import type { EpisodeHandle, EpisodeOutcome } from '../../../src/core/interfaces/agents.ts';
import type { Layout } from '../../../src/core/interfaces/context.ts';
import type { ToolSession } from '../../../src/core/interfaces/gateway.ts';
import type { BetDraft, Branch, Run } from '../../../src/core/types.ts';
import { A1, type Setup, setup } from '../models/fakes.ts';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type Message,
} from '../models/protocol.ts';
import { type BranchKit, branch, type Kit, kit, openExplorer } from '../tools/gateway-kit.ts';
export const DOMAINS = [
  { name: 'code', description: '写代码、修 bug、对接接口' },
  { name: 'research', description: '调研、报告、数学证明' },
  { name: 'general', description: '通用任务' },
];
export interface Flow {
  k: Kit;
  m: Setup;
  assembler: MelinaContextAssembler;
  explorer: ReturnType<typeof createExplorerAgent>;
  scoper: ReturnType<typeof createScoperAgent>;
  notices: string[];
}
export function flow(opts: Parameters<typeof kit>[0] = {}): Flow {
  const k = kit(opts),
    m = setup(),
    notices: string[] = [];
  const runner = createRoleCallRunner({ stream: m.stream, registry: m.registry });
  return {
    k,
    m,
    notices,
    assembler: new MelinaContextAssembler({ queries: k.runStore.queries, domains: () => DOMAINS }),
    explorer: createExplorerAgent({ runner, onNotice: (t) => notices.push(t) }),
    scoper: createScoperAgent({
      runner,
      registry: m.registry,
      domains: () => DOMAINS.map((d) => d.name),
      onNotice: (t) => notices.push(t),
    }),
  };
}
export function bet(f: Flow, over: Partial<BetDraft> = {}): Promise<BranchKit> {
  return branch(f.k, { kind: 'direct', label: '主干直解路线', model: A1, ...over });
}
export interface Episode {
  outcome: EpisodeOutcome;
  session: ToolSession;
  layout: Layout;
  handle: EpisodeHandle;
  requests: Message[][];
}
export async function episode(
  f: Flow,
  b: BranchKit,
  steps: FauxResponseStep[],
  opts: {
    onStart?: (handle: EpisodeHandle) => void;
    signal?: AbortSignal;
    run?: (run: Run) => Run;
    referenceContext?: () => string | undefined;
  } = {},
): Promise<Episode> {
  const requests: Message[][] = [];
  f.m.a.setResponses(
    steps.map((step) => async (ctx, options, state, model) => {
      requests.push(ctx.messages.slice());
      return typeof step === 'function' ? step(ctx, options, state, model) : step;
    }),
  );
  const current = f.k.runStore.queries.getBranch(b.branch.id)!;
  const layout = f.assembler.forExplorer(current),
    session = openExplorer(f.k, b),
    stored = f.k.runStore.queries.getRun(f.k.run.id)!;
  const handle = f.explorer.startEpisode({
    run: opts.run ? opts.run(stored) : stored,
    branch: current,
    bet: b.bet,
    layout,
    session,
    signal: opts.signal ?? new AbortController().signal,
    systemPrompt: () => f.assembler.forExplorer(f.k.runStore.queries.getBranch(b.branch.id)!).system,
    ...(opts.referenceContext ? { referenceContext: opts.referenceContext } : {}),
  });
  opts.onStart?.(handle);
  return { outcome: await handle.done, session, layout, handle, requests };
}
export const turn = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: 'toolUse' });
export const tool = (name: string, args: JsonObject) => fauxToolCall(name, args);
export const say = (text: string) => fauxAssistantMessage(text);
export function toolResults(messages: readonly Message[]) {
  return messages
    .filter((m) => m.role === 'toolResult')
    .map((m) => ({
      name: m.role === 'toolResult' ? m.toolName : '',
      text: m.role === 'toolResult' ? m.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : '',
      isError: m.role === 'toolResult' ? m.isError : false,
    }));
}
export function userTexts(messages: readonly Message[] | undefined): string[] {
  return (messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    );
}
export function closeInto(f: Flow, b: BranchKit, ep: EpisodeOutcome, snapshot: SnapshotId = `snap-${newId()}`) {
  const current = f.k.runStore.queries.getBranch(b.branch.id) as Branch;
  const base = { branchId: current.id, episode: current.episode, snapshot: { id: snapshot } };
  if (!ep.close)
    return f.k.runStore.writer.closeEpisode({ ...base, outcome: 'failed', failure: ep.failure ?? 'no_close' });
  return f.k.runStore.writer.closeEpisode({
    ...base,
    outcome: ep.close.kind === 'candidate' ? 'submitted' : 'ended',
    seenSeq: ep.seenSeq,
    ...(ep.close.kind === 'candidate'
      ? { candidate: { runId: f.k.run.id, branchId: current.id, snapshot, claim: ep.close.claim } }
      : { handoff: ep.close.handoff }),
  });
}
