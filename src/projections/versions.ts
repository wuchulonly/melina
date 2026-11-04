import type { VersionPicked } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { Candidate } from '../core/types.ts';
export function picksOf(q: RunStoreQueries, runId: Id): VersionPicked[] {
  return q
    .events({ since: 0, runId, types: ['version.picked'] })
    .flatMap((e) => (e.type === 'version.picked' ? [e.data] : []));
}
export function currentVersion(candidates: Candidate[], picks: VersionPicked[]): Candidate | undefined {
  const versions = candidates.filter((c) => c.interim);
  for (const pick of [...picks].reverse()) {
    const c = versions.find((c) => c.id === pick.candidateId);
    if (c) return c;
  }
  return versions[0];
}
