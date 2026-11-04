import { invalid, notFound } from '../../core/errors.ts';
import type { Id } from '../../core/ids.ts';
import type { Layout, PickRequest } from '../../core/interfaces/context.ts';
import type { RunStoreQueries } from '../../core/interfaces/store.ts';
import { goalBrief } from '../evidence.ts';
export interface SelectionSource {
  queries: RunStoreQueries;
  prompt: (name: 'selection') => string;
}
export function selectionLayout(src: SelectionSource, runId: Id, request: PickRequest): Layout {
  const run = src.queries.getRun(runId);
  if (!run) throw notFound('任务不存在');
  if (request.versions.length < 2) throw invalid('挑版至少需要两版');
  const candidates = new Map(src.queries.candidates(runId).map((c) => [c.id, c]));
  const versions = request.versions.map((v, i) => {
    const c = candidates.get(v.candidateId);
    if (!c?.interim) throw invalid('只能比较当前任务的阶段版本');
    return {
      number: i + 1,
      claim: c.claim,
      ...(v.artifact !== undefined ? { artifact: { path: c.artifactPath ?? '', text: v.artifact } } : {}),
      patch: v.patch || '（没有）',
    };
  });
  return {
    role: 'explorer',
    system: [src.prompt('selection'), goalBrief(run.goal)].join('\n\n'),
    tools: [],
    messages: [
      {
        role: 'user',
        text: JSON.stringify({
          inputs: src.queries.humanInputs(runId).map((input) => input.text),
          versions,
          sources: request.sources ?? [],
        }),
      },
    ],
    basedOnSeq: src.queries.lastSeq(),
  };
}
