// 通用题适配：持续 Pi 解题；每轮重建只读观察者；冻结增量记录与原版判断图合并；请求前替换摘要。
// 触发和预算统一成 Melina 的每 10 次环境工具、4 分钟、6 次只读查询。
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolSession } from '../../../src/core/interfaces/gateway.ts';
import type { ClosingToolName, ToolSpec } from '../../../src/core/tools.ts';
import type { BaselineObserver, BaselineObserverDeps } from '../baseline.ts';
import { ContextSchema, parseSubmission, SubmitSchema } from './vendor/heimdall-contract.ts';
import { type Evidence, mergeObservation, type ObservationState } from './vendor/heimdall-state.ts';

export const OBSERVER_SYSTEM = [
  '你是独立的只读巡检器。另一个 agent 正在解题；你只根据真实的工具操作和结果整理它的判断图。',
  '不解题、不执行命令、不编写交付物、不接触判题真值。实际行动和输出优先，计划和自述不是已执行证据。',
  '每轮是新会话，只靠之前已发布的判断图和这一轮的增量记录记事。保留稳定 id，更新方向时保留尝试历史。',
  'inferred-open 是未实测的方向；tried-hit 是实测支持；tried-miss 只表示该行动在当时条件下失败，不能把整个方向判死。',
  '每个已尝试的判断必须有 attempts，action、result 和 turn:N 证据。task 文本可支撑需求，不能支撑执行结论。',
  '用 dependsOn 记录明确的依赖，不能形成循环。过时节点可 retire；不删除历史来掩盖失败。',
  'guidance.hypothesis 是当前解释，lock 是有证据支持的下一步约束，confirmedIds 最多 8 个，angleIds 最多 4 个未试方向。',
  'tension 为空或两条互相冲突的原话；uncertainty 写清未证明的条件。未试方向只供参考，不是必须逐一完成的清单。',
  '不要因自己的猜想让主 agent 停下或增加题目之外的验收标准。',
  '用 observation_context 按证据 id 或判断 id 查看完整内容；最多查询 6 次，够用就单独调用 submit_observation。',
  'submit_observation 参数是 {baseRevision,upserts,retireIds,guidance}。baseRevision 必须和本轮给的相同，首轮 null。',
  'upserts 每项包含 id,subject,status,conclusion,basis,uncertainty,evidenceRefs,attempts；attempts 用 [] 仅限 inferred-open。',
  'guidance 包含 hypothesis,lock,angleIds,confirmedIds,tension；空 hypothesis 或 lock 用 null。loot 禁用。',
].join('\n');

type Entry = { ref: string; tool: string; action: string; result: string; isError: boolean; at: number };

/** 新版只替换一次，不让历史地图进入会话日志；这是原版代理在发请求时改 system 的位置。 */
export function replaceMap(original: string, map: string): string {
  const stripped = original.replace(/<heimdall-map>[\s\S]*?<\/heimdall-map>\s*/g, '').trimEnd();
  return map ? `${stripped}\n\n${map}` : stripped;
}

export function compileMap(state: ObservationState): string {
  const byId = new Map(state.assessments.map((a) => [a.id, a]));
  const line = (s: string) =>
    s
      .replace(/<\/?heimdall-map>/gi, '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  return [
    '<heimdall-map>',
    'HYPOTHESIS:',
    ...(state.guidance.hypothesis ? [`- ${line(state.guidance.hypothesis)}`] : []),
    'CONFIRMED:',
    ...state.guidance.confirmedIds.map((id) => `- ${line(byId.get(id)!.subject)}: ${line(byId.get(id)!.conclusion)}`),
    'LOCK:',
    ...(state.guidance.lock ? [`- ${line(state.guidance.lock)}`] : []),
    'ANGLES:',
    ...state.guidance.angleIds.map((id) => `- ${line(byId.get(id)!.subject)}`),
    ...(state.guidance.tension.length ? ['TENSION:', ...state.guidance.tension.map((s) => `- ${line(s)}`)] : []),
    '</heimdall-map>',
  ].join('\n');
}

export function heimdallObserver(deps: BaselineObserverDeps): BaselineObserver {
  const t0 = Date.now();
  const entries: Entry[] = [];
  const evidence: Record<string, Evidence> = { 'input:task': { kind: 'input', text: deps.goal } };
  const dir = join(deps.dir, 'observer');
  mkdirSync(dir, { recursive: true });
  const log = (entry: Record<string, unknown>) =>
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ at: Date.now() - t0, ...entry })}\n`);
  let state: ObservationState = {
    version: 1,
    jobId: deps.meta.runId,
    revision: null,
    submissionHash: null,
    assessments: [],
    retired: [],
    loot: [],
    cursor: { events_byte: 0, http_byte: 0, turns_byte: 0 },
    guidance: { hypothesis: null, lock: null, angleIds: [], confirmedIds: [], tension: [] },
  };
  let map = '';
  let published = 0;
  let cursor = 0;
  let nextAt = 10;
  let failures = 0;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let roundAbort: AbortController | undefined;
  const stop = () => {
    stopped = true;
    roundAbort?.abort('主会话结束或被取消');
  };
  deps.meta.signal?.addEventListener('abort', stop, { once: true });

  const launch = () => {
    if (stopped || inFlight || entries.length < nextAt) return;
    const end = entries.length;
    const frozenEvidence = structuredClone(evidence);
    const base = structuredClone(state);
    const window = entries.slice(cursor, end);
    const incremental = window.map((e, i) => ({
      ...e,
      result: i < window.length - 30 ? e.result.replace(/\s+/g, ' ').slice(0, 240) : e.result.slice(-4000),
      action: e.action.slice(0, 700),
    }));
    const previous = { ...base, assessments: base.assessments.map((a) => ({ ...a, attempts: a.attempts.slice(-3) })) };
    const abort = new AbortController();
    roundAbort = abort;
    const timeout = setTimeout(() => abort.abort('观察者一轮已用满 4 分钟'), 4 * 60_000);
    log({ event: 'round_started', from: cursor + 1, until: end, baseRevision: base.revision });
    inFlight = (async () => {
      let reads = 0;
      let submissions = 0;
      let closed: ReturnType<ToolSession['closed']>;
      const context: ToolSpec = {
        name: 'observation_context' as ToolSpec['name'],
        parameters: ContextSchema,
        description: '只读展开本轮冻结的证据原文或判断节点；evidenceRefs 或 assessmentIds。',
      };
      const submit: ToolSpec = {
        name: 'submit_observation' as ToolSpec['name'],
        parameters: SubmitSchema,
        description: '单独调用，提交以真实行动和结果为依据的增量判断图；校验成功才发布。',
      };
      const session: ToolSession = {
        caller: { ...deps.caller, role: 'watcher', readOnly: true },
        tools: [
          {
            spec: context,
            async run(call) {
              reads++;
              if (reads > 6) return { content: '已查询 6 次；请按已见证据提交。', isError: true };
              const args = call.args as { evidenceRefs?: string[]; assessmentIds?: string[] };
              return {
                content: JSON.stringify({
                  revision: base.revision,
                  evidence: Object.fromEntries((args.evidenceRefs ?? []).map((id) => [id, frozenEvidence[id] ?? null])),
                  assessments: (args.assessmentIds ?? []).map(
                    (id) => base.assessments.find((a) => a.id === id) ?? null,
                  ),
                }),
                isError: false,
              };
            },
          },
          {
            spec: submit,
            async run(call) {
              submissions++;
              try {
                const request = parseSubmission(call.args);
                const next = mergeObservation(base, request, frozenEvidence, false);
                if (next.assessments.length > 30) throw new Error('最多 30 个活跃节点，请 retire 过时节点。');
                const edges = next.assessments.reduce((n, a) => n + Math.max(1, a.dependsOn?.length ?? 0), 1);
                if (edges > 48) throw new Error('最多 48 条依赖边，请 retire 过时节点。');
                if (stopped || abort.signal.aborted) throw new Error('这一轮已结束，不能发布。');
                next.revision = randomUUID();
                next.cursor.turns_byte = end;
                const compiled = compileMap(next);
                const version = ++published;
                writeFileSync(join(dir, `observation-${version}.json`), `${JSON.stringify(next, null, 2)}\n`);
                writeFileSync(join(dir, `inject-${version}.txt`), compiled);
                writeFileSync(join(dir, 'current.tmp'), `${version}\n`);
                renameSync(join(dir, 'current.tmp'), join(dir, 'current'));
                state = next;
                map = compiled;
                cursor = end;
                failures = 0;
                nextAt = end + 10;
                closed = { tool: 'submit_observation' as ClosingToolName, args: request };
                log({ event: 'published', version, until: end, nodes: next.assessments.length, chars: map.length });
                return { content: '已校验并发布。', isError: false, terminate: true };
              } catch (error) {
                const message = String(error);
                log({ event: 'rejected', message: deps.redactor.redact(message) });
                if (submissions >= 3) abort.abort('增量判断图连续 3 次未通过校验');
                return { content: message, isError: true };
              }
            },
          },
        ],
        check: (call, turn) => (call.name === 'submit_observation' && turn.length > 1 ? '提交要单独调用。' : undefined),
        get toolCalls() {
          return reads;
        },
        closed: () => closed,
      };
      const result = await deps.runner.start({
        meta: { ...deps.meta, signal: abort.signal },
        session,
        layout: {
          role: 'watcher',
          system: OBSERVER_SYSTEM,
          tools: session.tools.map((t) => t.spec),
          basedOnSeq: end,
          messages: [{ role: 'user', text: JSON.stringify({ goal: deps.goal, previous, incremental }) }],
        },
        closeReminder: '看完请单独调用 submit_observation，保留原 id 和证据引用。',
      }).done;
      if (!closed && !stopped) {
        failures = Math.min(3, failures + 1);
        nextAt = entries.length + 10 * 2 ** failures;
        log({ event: 'round_failed', outcome: result.outcome, retryAfter: nextAt });
      }
    })()
      .catch((error) => {
        failures = Math.min(3, failures + 1);
        nextAt = entries.length + 10 * 2 ** failures;
        log({ event: 'round_error', message: deps.redactor.redact(String(error)) });
      })
      .finally(() => {
        clearTimeout(timeout);
        roundAbort = undefined;
        inFlight = undefined;
        launch();
      });
  };

  return {
    system(original) {
      log({ event: 'request', version: published, toolCalls: entries.length, mapChars: map.length });
      return replaceMap(original, map);
    },
    observe(call, outcome) {
      if (stopped || call.name === 'done') return;
      const ref = `turn:${entries.length + 1}`;
      const action = deps.redactor.redact(JSON.stringify({ tool: call.name, args: call.args }));
      const result = deps.redactor.redact(outcome.content);
      const entry = { ref, tool: call.name, action, result, isError: outcome.isError, at: Date.now() - t0 };
      entries.push(entry);
      evidence[ref] = { kind: 'excerpt', text: JSON.stringify(entry) };
      log({ event: 'evidence', ...entry });
      launch();
    },
    async close() {
      stop();
      deps.meta.signal?.removeEventListener('abort', stop);
      await inFlight;
      writeFileSync(join(dir, 'final.json'), `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}
