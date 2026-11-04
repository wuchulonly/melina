// Heimdall MIT 源码的纯状态合并，固定 d9368848a5b0dbd5b87cfa476fee0ce9cb5a48ea。
// 未包含 CTF playbook、扫描、凭证字典、题目解法。
import {
  type Assessment,
  type Guidance,
  type Issue,
  type LootItem,
  type ObservationSubmit,
  ObservationValidationError,
} from './heimdall-contract.ts';
export type Evidence = { kind: 'excerpt' | 'input' | 'receipt'; text: string };
export type ObservationCursor = { events_byte: number; http_byte: number; turns_byte: number };
export type ObservationState = {
  version: 1;
  jobId: string;
  revision: string | null;
  submissionHash: string | null;
  assessments: Assessment[];
  retired: Assessment[];
  guidance: Guidance;
  loot: LootItem[];
  cursor: ObservationCursor;
};
export function mergeObservation(
  base: ObservationState,
  request: ObservationSubmit,
  evidence: Record<string, Evidence>,
  dictionaryEnabled: boolean,
): ObservationState {
  const errors: Issue[] = [];
  const fail = (path: string, code: string, message: string) => errors.push({ path, code, message });
  if (request.baseRevision !== base.revision)
    fail('/baseRevision', 'stale_revision', `Expected ${base.revision}; refresh observation_context.`);
  const seen = new Set<string>();
  for (const [i, item] of request.upserts.entries()) {
    if (seen.has(item.id)) fail(`/upserts/${i}/id`, 'duplicate_id', item.id);
    if (['start', 'recon', 'spray-dict'].includes(item.id) || item.id.startsWith('host-flag-'))
      fail(`/upserts/${i}/id`, 'reserved_id', item.id);
    if (request.retireIds.includes(item.id))
      fail(`/upserts/${i}/id`, 'conflicting_update', 'Cannot update and retire the same assessment.');
    const attempts = new Set<string>();
    for (const [j, attempt] of item.attempts.entries()) {
      if (attempts.has(attempt.id)) fail(`/upserts/${i}/attempts/${j}/id`, 'duplicate_id', attempt.id);
      attempts.add(attempt.id);
    }
    seen.add(item.id);
  }
  const next = structuredClone(base);
  const active = new Map(next.assessments.map((a) => [a.id, a]));
  const retired = new Map(next.retired.map((a) => [a.id, a]));
  for (const id of request.retireIds) {
    const previous = active.get(id);
    if (!previous && !retired.has(id)) fail('/retireIds', 'unknown_id', id);
    if (previous) {
      retired.set(id, previous);
      active.delete(id);
    }
  }
  for (const item of request.upserts) {
    const old = active.get(item.id) || retired.get(item.id);
    const attempts = new Map((old?.attempts || []).map((a) => [a.id, a]));
    for (const attempt of item.attempts) attempts.set(attempt.id, attempt);
    active.set(item.id, {
      ...item,
      role: item.role ?? old?.role,
      api: item.api ?? old?.api,
      attempts: [...attempts.values()],
      dependsOn: item.dependsOn ?? old?.dependsOn ?? [],
    });
    retired.delete(item.id);
  }
  next.assessments = [...active.values()];
  next.retired = [...retired.values()];
  if (request.guidance) next.guidance = structuredClone(request.guidance);
  else {
    next.guidance.angleIds = next.guidance.angleIds.filter((id) => active.has(id));
    next.guidance.confirmedIds = next.guidance.confirmedIds.filter((id) => active.has(id));
  }
  const checkRefs = (refs: string[], path: string, execution = false) => {
    for (const ref of refs) if (!evidence[ref]) fail(path, 'unknown_evidence', ref);
    if (execution && !refs.some((ref) => ['excerpt', 'receipt'].includes(evidence[ref]?.kind || '')))
      fail(path, 'execution_evidence_required', 'An attempt needs a real turn or platform receipt, not task text.');
  };
  for (const a of next.assessments) {
    const path = `/assessments/${a.id}`;
    checkRefs(a.evidenceRefs, `${path}/evidenceRefs`);
    if (a.status !== 'inferred-open' && !a.attempts.length)
      fail(`${path}/attempts`, 'missing_attempt', 'Attempted judgments require at least one evidenced attempt.');
    const attemptIds = new Set<string>();
    for (const attempt of a.attempts) {
      if (attemptIds.has(attempt.id)) fail(`${path}/attempts/${attempt.id}`, 'duplicate_id', attempt.id);
      attemptIds.add(attempt.id);
      checkRefs(attempt.evidenceRefs, `${path}/attempts/${attempt.id}/evidenceRefs`, true);
    }
    if (a.attempts.length > 20)
      fail(
        `${path}/attempts`,
        'too_many_attempts',
        `${a.attempts.length} attempts; retire this assessment and start a new phase instead of dropping history.`,
      );
    for (const parent of a.dependsOn || [])
      if (!active.has(parent)) fail(`${path}/dependsOn`, 'unknown_dependency', parent);
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      fail(`/assessments/${id}/dependsOn`, 'cycle', 'Dependencies must not form a cycle.');
      return;
    }
    if (done.has(id)) return;
    visiting.add(id);
    for (const parent of active.get(id)?.dependsOn || []) if (active.has(parent)) visit(parent);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of active.keys()) visit(id);
  for (const id of next.guidance.angleIds) {
    if (!active.has(id)) fail('/guidance/angleIds', 'unknown_id', id);
    else if (active.get(id)!.status !== 'inferred-open')
      fail('/guidance/angleIds', 'not_open', `${id} is not an untried direction.`);
  }
  for (const id of next.guidance.confirmedIds)
    if (!active.get(id)?.attempts.length)
      fail('/guidance/confirmedIds', 'missing_attempt', `${id} has no recorded attempt.`);
  if (next.guidance.tension.length === 1)
    fail('/guidance/tension', 'incomplete_tension', 'Provide both conflicting quotations or an empty list.');
  if (request.loot?.length && !dictionaryEnabled)
    fail('/loot', 'disabled', 'Credential dictionary generation is not enabled for this job.');
  const loot = new Map(next.loot.map((l) => [`${l.bucket}\0${l.value}`, l]));
  for (const [i, item] of (request.loot || []).entries()) {
    checkRefs(item.evidenceRefs, `/loot/${i}/evidenceRefs`);
    loot.set(`${item.bucket}\0${item.value}`, item);
  }
  next.loot = [...loot.values()];
  if (errors.length) throw new ObservationValidationError(errors);
  return next;
}
