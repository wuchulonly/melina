// 业务探索场景：判题重新生成初始状态并重放数据，不执行交付程序。
import { isDeepStrictEqual } from 'node:util';
import type { CompletionSpec } from '../../../src/core/types.ts';
import { makeRequest, type SimRequest, type SimResponse } from '../../sim/kit/http.ts';
import { parseJson, readDeliverable, type SimWorld, type SolveContext } from '../../sim/task.ts';
import type { EvalTask } from '../task.ts';
import { type EvidenceStep, naiveScenario } from './client.ts';

export interface ScenarioRun {
  handle(req: SimRequest): SimResponse;
  /** 返回未满足的结果或对照；undefined 表示复现成立。 */
  judge(answer: Record<string, unknown>): string | undefined;
}

export interface ScenarioFixture {
  handover: Record<string, unknown>;
  truth: Record<string, unknown>;
  open(): ScenarioRun;
}

export interface ScenarioDefinition {
  id: string;
  env: 'web' | 'workflow';
  title: string;
  goal: string;
  controls: string;
  answer: string;
  generate(seed: string): ScenarioFixture;
  solve(ctx: SolveContext): Promise<void>;
}

export function scenarioTask(def: ScenarioDefinition): EvalTask {
  return {
    id: def.id,
    env: def.env,
    suite: 'sim',
    difficulty: 'hard',
    gate: 3,
    title: def.title,
    domain: 'general',
    solve: def.solve,
    naive: naiveScenario,
    create(seed): SimWorld {
      const fixture = def.generate(seed);
      return {
        seed,
        statement: (url) =>
          `${def.goal} ${def.controls} 入口 ${url}，业务对象和操作范围在 handover.json；先从 GET /api 了解现有功能。` +
          `交付 answer.json（${def.answer}）、evidence.json 和 report.md，格式见 evidence-format.md。` +
          '所有对象都属于同一测试工作区，可通过本实例接口检查样本、推进调度和操作业务状态。',
        completion: (): CompletionSpec => ({
          interpretation: def.goal,
          criteria: [
            `answer.json 的结果可核对：${def.answer}`,
            def.controls,
            'evidence.json 从干净实例重放后，能复现目标结果和题目要求的正常/失败对照；每步响应与实际一致',
            'report.md 说明观测支持的结论，引用至少一条成功观测和一条失败对照',
          ],
        }),
        materials: (url) => [
          { name: 'handover.json', content: `${JSON.stringify(fixture.handover, null, 2)}\n` },
          {
            name: 'evidence-format.md',
            content:
              `# 调查交付\n\n当前入口：${url}\n\n` +
              '交付结果见目标中的 answer.json 字段。evidence.json 是 {"steps": [...]}，最多 160 步，' +
              '每步格式：{"request":{"method":"GET","path":"/api","headers":{}},' +
              '"response":{"status":200,"body":完整实际 JSON 响应}}。需要请求体时加 request.body。\n\n' +
              'path 是本实例下以 / 开头的相对路径，可含查询串；保留业务请求头。只收 JSON 请求和响应。' +
              '请求按数组顺序从全新实例重放；不要省略创建作业、排队、调度或改状态的步骤。' +
              '每步从 0 编号，report.md 用 [依据](evidence.json#step-0) 引用对应观测，至少引用成功和失败对照各一条。\n\n' +
              '排队任务的测试调度方式在接口说明中；不依赖现实时间，不需要提交可执行程序。' +
              '素材由本实例的资源编号表示，所有操作都在本实例内完成。\n',
          },
        ],
        starter: () => ({ 'README.md': `${def.title}\n\n在此目录提交三个调查文件。\n` }),
        handler: () => fixture.open(),
        deliverables: () => ['answer.json', 'evidence.json', 'report.md'],
        check: (dir) => checkReplay(fixture, dir),
        summary: () => ({ ...fixture.truth, scenario: def.id, grading: 'fresh-state-json-replay' }),
      };
    },
  };
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function equals(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function checkReplay(fixture: ScenarioFixture, dir: string): { pass: boolean; summary: string } {
  const fail = (summary: string) => ({ pass: false, summary });
  const answerFile = readDeliverable(dir, 'answer.json', 64 * 1024);
  const evidenceFile = readDeliverable(dir, 'evidence.json');
  const report = readDeliverable(dir, 'report.md', 64 * 1024);
  if ('error' in answerFile) return fail(answerFile.error);
  if ('error' in evidenceFile) return fail(evidenceFile.error);
  if ('error' in report) return fail(report.error);
  const answer = parseJson(answerFile.text, 'answer.json');
  const evidence = parseJson(evidenceFile.text, 'evidence.json');
  if ('error' in answer) return fail(answer.error);
  if ('error' in evidence) return fail(evidence.error);
  if (!isObject(answer.value)) return fail('answer.json 必须是对象');
  const steps = object(evidence.value).steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 160) return fail('证据需要 1 至 160 步');
  const refs = [...report.text.matchAll(/evidence\.json#step-(\d+)/g)].map((m) => Number(m[1]));
  if (report.text.trim().length < 60 || refs.length < 2 || refs.some((n) => n >= steps.length)) {
    return fail('报告需要说明结论并引用有效的成功观测和失败对照');
  }
  const run = fixture.open();
  const statuses: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = parseStep(steps[i]);
    if (!step) return fail(`证据第 ${i} 步格式不合法`);
    let actual: SimResponse;
    try {
      actual = run.handle(makeRequest(step.request.method, step.request.path, step.request));
    } catch {
      return fail(`证据第 ${i} 步不能重放`);
    }
    // HTTP 会去掉 undefined；保持与完整 JSON 响应的同一口径。
    const body: unknown = JSON.parse(JSON.stringify(actual.body ?? null));
    if (actual.status !== step.response.status || !equals(body, step.response.body)) {
      return fail(`证据第 ${i} 步的响应与重放结果不符`);
    }
    statuses.push(actual.status);
  }
  if (!refs.some((n) => statuses[n]! >= 200 && statuses[n]! < 300) || !refs.some((n) => statuses[n]! >= 400)) {
    return fail('报告必须引用成功观测和失败对照各一条');
  }
  const wrong = run.judge(answer.value);
  return wrong ? fail(wrong) : { pass: true, summary: '结果正确，完整请求链和失败对照在干净实例中重放成立' };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseStep(value: unknown): EvidenceStep | undefined {
  const step = object(value);
  const req = object(step.request);
  const res = object(step.response);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method))) return undefined;
  if (
    typeof req.path !== 'string' ||
    req.path.length > 4096 ||
    !req.path.startsWith('/') ||
    req.path.startsWith('//')
  ) {
    return undefined;
  }
  const url = new URL(req.path, 'http://sim.local');
  if (url.origin !== 'http://sim.local' || url.hash) return undefined;
  if (!Number.isInteger(res.status) || Number(res.status) < 100 || Number(res.status) > 599 || !('body' in res)) {
    return undefined;
  }
  if (req.headers !== undefined) {
    if (!isObject(req.headers) || Object.keys(req.headers).length > 24) return undefined;
    if (
      Object.entries(req.headers).some(([k, v]) => !/^[a-z0-9-]+$/i.test(k) || typeof v !== 'string' || v.length > 4096)
    ) {
      return undefined;
    }
  }
  return {
    request: {
      method: String(req.method),
      path: req.path,
      ...(req.headers === undefined ? {} : { headers: req.headers as Record<string, string> }),
      ...('body' in req ? { body: req.body } : {}),
    },
    response: { status: Number(res.status), body: res.body },
  };
}
