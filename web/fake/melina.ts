// 内存演示后端：使用当前 direct 会话和摘要接力契约，不调模型或执行命令。
import { createHash } from 'node:crypto';
import type {
  BranchDetail,
  BranchDiffResponse,
  CreateRunRequest,
  InputRequest,
  ModelCatalogResponse,
  RunProgress,
  RunResultResponse,
  RunSummary,
  UsageResponse,
} from '../../src/core/api.ts';
import {
  type CustomProvider,
  credentialProblem,
  type ModelsConfig,
  resolveRunConfig,
  type Settings,
} from '../../src/core/config.ts';
import { conflict, invalid, notFound } from '../../src/core/errors.ts';
import type { MelinaEvent, MelinaEventOf, SystemStatus } from '../../src/core/events.ts';
import { type Id, newId } from '../../src/core/ids.ts';
import { ENDED_RUN_STATUSES, type HumanInput, type Run } from '../../src/core/types.ts';
import { allScripts } from '../../test/fixtures/runs/index.ts';
import { branchDetail, replay, runList, runResult, runSummary } from '../../test/fixtures/runs/project.ts';
import {
  MODEL_CATALOG,
  MODELS_CONFIG,
  MODELS_CONFIG_SINGLE,
  SETTINGS,
  STATUS_OK,
  STATUS_TROUBLE,
  USAGE,
} from '../../test/fixtures/static.ts';
import { listDirs } from './dirs.ts';
export type StartPoint = number | 'begin' | 'end';
export type StartPreset = 'live' | 'end' | 'begin';
export interface FakeOptions {
  speed?: number;
  start?: StartPreset | Record<string, StartPoint>;
  status?: 'ok' | 'trouble';
  models?: 'two' | 'single' | 'empty';
  settings?: 'default' | 'empty';
}
export type FakeListener = (event: MelinaEvent) => void;
export class FakeMelina {
  private log: MelinaEvent[] = [];
  private tracks: { name: string; events: MelinaEvent[]; pos: number; frozen: boolean }[] = [];
  private artifacts = new Map<string, { content: string | Uint8Array }>();
  private readonly listeners = new Set<FakeListener>();
  private readonly resetListeners = new Set<() => void>();
  private readonly keys = new Map<string, string>();
  private readonly secrets = new Map<Id, string>();
  private models: ModelsConfig = structuredClone(MODELS_CONFIG);
  private settings: Settings = structuredClone(SETTINGS);
  private status: SystemStatus = structuredClone(STATUS_OK);
  private speed = 0;
  private timer?: ReturnType<typeof setInterval>;
  private recent: ReturnType<typeof listDirs>['recent'] = [];
  private readonly clock: () => number;
  constructor(options: FakeOptions = {}, clock: () => number = Date.now) {
    this.clock = clock;
    this.reset(options);
  }
  reset(options: FakeOptions = {}): void {
    this.close();
    this.log = [];
    this.artifacts.clear();
    this.tracks = [];
    this.loadModels(options.models ?? 'two');
    this.loadSettings(options.settings ?? 'default');
    this.status = this.baseStatus(options.status ?? 'ok');
    for (const script of allScripts()) {
      const point =
        typeof options.start === 'object' ? (options.start[script.name] ?? 'begin') : (options.start ?? 'live');
      const end =
        point === 'end'
          ? script.events.length
          : point === 'begin'
            ? 0
            : point === 'live'
              ? (script.moments[0]?.seq ?? 0)
              : point;
      const track = { name: script.name, events: script.events, pos: 0, frozen: false };
      this.tracks.push(track);
      for (const [handle, content] of Object.entries(script.artifacts)) this.artifacts.set(handle, { content });
      while (track.pos < Math.min(end, track.events.length)) {
        const event = track.events[track.pos++];
        if (event) this.push(event);
      }
    }
    for (const cb of this.resetListeners) cb();
    this.setSpeed(options.speed ?? 5);
  }
  private now(): number {
    return this.clock();
  }
  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0) throw invalid('倍速必须为非负数');
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.speed = speed;
    if (speed > 0) {
      this.timer = setInterval(() => this.step(), 1000 / speed);
      this.timer.unref();
    }
  }
  getSpeed(): number {
    return this.speed;
  }
  step(count = 1, name?: string): MelinaEvent[] {
    const out: MelinaEvent[] = [];
    for (let i = 0; i < count; i++) {
      const t = this.tracks.find((t) => (!name || t.name === name) && t.pos < t.events.length);
      if (!t) break;
      const e = t.events[t.pos++];
      if (!e) break;
      const run = e.runId ? replay(this.log).runs.get(e.runId) : undefined;
      if (
        run?.status === 'paused' ||
        (run && ENDED_RUN_STATUSES.includes(run.status as (typeof ENDED_RUN_STATUSES)[number]))
      )
        continue;
      out.push(this.push(e));
    }
    return out;
  }
  describe() {
    return {
      speed: this.speed,
      lastSeq: this.log.at(-1)?.seq ?? 0,
      tracks: this.tracks.map((t) => ({
        name: t.name,
        runIds: [...new Set(t.events.map((e) => e.runId).filter(Boolean))],
        pos: t.pos,
        total: t.events.length,
        frozen: t.frozen,
      })),
    };
  }
  subscribe(cb: FakeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onReset(cb: () => void): () => void {
    this.resetListeners.add(cb);
    return () => this.resetListeners.delete(cb);
  }
  eventsSince(seq: number, runId?: Id): MelinaEvent[] {
    return structuredClone(this.log.filter((e) => e.seq > seq && (!runId || e.runId === runId)));
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private push(event: MelinaEvent): MelinaEvent {
    const seq = (this.log.at(-1)?.seq ?? 0) + 1;
    const data = 'seq' in event.data ? { ...event.data, seq } : event.data;
    const e = { ...event, seq, data } as MelinaEvent;
    this.log.push(e);
    for (const cb of this.listeners) cb(e);
    return e;
  }
  private emit<K extends MelinaEvent['type']>(type: K, runId: Id, data: MelinaEventOf<K>['data']): MelinaEvent {
    return this.push({ type, runId, data, at: new Date(this.now()).toISOString(), seq: 0 } as MelinaEvent);
  }
  listRuns() {
    return runList(this.log);
  }
  getRun(id: Id): RunSummary {
    return structuredClone(runSummary(this.log, id));
  }
  progress(id: Id): RunProgress {
    const summary = this.getRun(id),
      rows = this.log.filter((e) => e.runId === id),
      tools = rows.filter((e) => e.type === 'observation.created'),
      episodes = rows.filter((e) => e.type === 'episode.closed'),
      branches = rows.filter((e) => e.type === 'branch.created');
    const lastBranch = branches.at(-1);
    const lastCandidate = rows.findLast((e) => e.type === 'candidate.created');
    return {
      runId: id,
      sampledAt: this.now() / 1000,
      windowSeconds: 600,
      lastSeq: summary.lastSeq,
      branchesCount: branches.length,
      activeBranches: summary.branches.filter((c) => c.branch.state === 'running' || c.branch.state === 'starting')
        .length,
      queuedBranches: summary.branches.filter((c) => c.branch.queued).length,
      recentBranches: branches.length,
      lastBranchAt: lastBranch ? Date.parse(lastBranch.at) / 1000 : null,
      episodesCount: episodes.length,
      recentEpisodes: episodes.length,
      episodesSinceProgress: 0,
      toolCallsCount: tools.length,
      recentToolCalls: tools.length,
      toolCallsSinceProgress: 0,
      goalProgressSeq: lastCandidate?.seq ?? 0,
      lastGoalProgressAt: lastCandidate ? Date.parse(lastCandidate.at) / 1000 : null,
      lastGoalProgressKind: lastCandidate ? 'record' : null,
      candidatesCount: summary.candidates.length,
      observer: null,
    };
  }
  branch(id: Id, branchId: Id, cursor?: string, limit?: number): BranchDetail {
    return structuredClone(branchDetail(this.log, id, branchId, cursor, limit));
  }
  branchDiff(id: Id, branchId: Id): BranchDiffResponse {
    return { snapshot: this.branch(id, branchId).branch.lastSnapshot };
  }
  result(id: Id): RunResultResponse {
    return runResult(this.log, id);
  }
  artifact(id: Id, hash: string) {
    this.getRun(id);
    const found = this.artifacts.get(`art://${hash}`);
    if (!found) throw notFound('没有这个产物');
    return found;
  }
  usage(): UsageResponse {
    return structuredClone(USAGE);
  }
  systemStatus(): SystemStatus {
    return structuredClone(this.status);
  }
  dirs(prefix: string) {
    return listDirs(prefix, this.recent);
  }
  createRun(req: CreateRunRequest, uploads: { name: string; content: Uint8Array }[] = []): { runId: Id } {
    const runId = newId();
    const template = allScripts()[0]?.moments[0]?.summary.run;
    if (!template) throw new Error('缺少演示任务');
    const materials = uploads.map((u) => {
      const handle = `art://${createHash('sha256').update(u.content).digest('hex')}` as const;
      this.artifacts.set(handle, { content: u.content });
      return { name: u.name, handle };
    });
    const run: Run = {
      ...template,
      id: runId,
      seq: 0,
      goal: { ...template.goal, statement: req.statement, materials },
      workspace: { root: req.workspace ?? `/tmp/melina-demo/${runId}`, kind: 'dir-copy' },
      config: resolveRunConfig(req.config ?? {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.emit('run.created', runId, run);
    const choice = run.config.bet0.models;
    const models = Array.isArray(choice) ? choice : this.models[choice.tier];
    const copies = Array.isArray(choice) ? choice.length : (run.config.bet0.copies ?? models.length);
    for (let i = 0; i < copies; i++) {
      const betId = newId();
      const model = models[i % Math.max(1, models.length)];
      if (!model) throw conflict('先配置模型');
      this.emit('bet.created', runId, {
        id: betId,
        seq: 0,
        runId,
        kind: 'direct',
        label: `直解 ${i + 1}`,
        model,
        startFrom: { snapshot: 'root' },
        source: { kind: 'template' },
        status: 'active',
      });
      this.emit('branch.created', runId, {
        id: newId(),
        runId,
        seq: 0,
        betId,
        state: 'running',
        queued: false,
        lastSnapshot: 'root',
        seenSeq: 0,
        episode: 1,
        toolCalls: 0,
        failures: 0,
        weight: 1,
      });
    }
    return { runId };
  }
  input(id: Id, req: InputRequest): { input: HumanInput } {
    const run = this.getRun(id).run;
    if (run.status !== 'running' && run.status !== 'paused') throw conflict('任务已结束');
    const input: HumanInput = {
      id: newId(),
      runId: id,
      seq: 0,
      text: req.text,
      ...(req.key ? { key: req.key } : {}),
      ...(req.acceptance ? { acceptance: req.acceptance } : {}),
    };
    const saved = this.emit('input.created', id, input);
    return { input: saved.data as HumanInput };
  }
  pause(id: Id): { run: Run } {
    const r = this.getRun(id).run;
    if (r.status !== 'running') throw conflict('任务未运行');
    return { run: this.updateRun(r, { status: 'paused' }) };
  }
  resume(id: Id): { run: Run } {
    const r = this.getRun(id).run;
    if (r.status !== 'paused') throw conflict('任务未暂停');
    return { run: this.updateRun(r, { status: 'running' }) };
  }
  cancel(id: Id): { run: Run } {
    const r = this.getRun(id).run;
    const text = `# 任务记录\n${r.goal.statement}\n`;
    const handle = `art://${createHash('sha256').update(text).digest('hex')}` as const;
    this.artifacts.set(handle, { content: text });
    return {
      run: this.updateRun(r, {
        status: 'cancelled',
        endedAt: new Date(this.now()).toISOString(),
        result: { knowledgeReport: handle },
      }),
    };
  }
  deleteRun(id: Id): void {
    const r = this.getRun(id).run;
    if (r.status === 'running' || r.status === 'paused') throw conflict('先结束任务');
    this.log = this.log.filter((e) => e.runId !== id);
    for (const cb of this.resetListeners) cb();
  }
  private updateRun(run: Run, patch: Partial<Run>): Run {
    this.emit('run.updated', run.id, { ...run, ...patch });
    return this.getRun(run.id).run;
  }
  modelCatalog(): ModelCatalogResponse {
    const keyed = new Set(
      this.models.providers.filter((p) => (p.keys ?? []).some((k) => k.hasKey)).map((p) => p.provider),
    );
    const custom = this.models.providers.flatMap((p) =>
      p.custom
        ? [
            {
              provider: p.provider,
              ...(p.custom.name ? { name: p.custom.name } : {}),
              baseUrl: p.custom.baseUrl,
              custom: true,
              hasKey: false,
              models: p.custom.models.map((m) => ({
                model: m.model,
                ...(m.name ? { name: m.name } : {}),
                contextWindow: m.contextWindow ?? 128_000,
                maxOutput: m.maxOutput ?? 16_384,
                reasoning: m.reasoning === true,
                ...(m.price ? { price: m.price } : {}),
              })),
            },
          ]
        : [],
    );
    return {
      providers: [...MODEL_CATALOG.providers, ...custom].map((p) => ({
        ...structuredClone(p),
        hasKey: keyed.has(p.provider),
      })),
    };
  }

  getModels(): ModelsConfig {
    return structuredClone(this.models);
  }

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  putModels(body: ModelsConfig): ModelsConfig {
    const before = new Map(this.models.providers.map((p) => [p.provider, p]));
    const seen = new Set<string>();
    const providers: ModelsConfig['providers'] = [];
    for (const p of body.providers) {
      const name = p.provider.trim();
      if (!name) throw invalid('供应商的名字不能是空的');
      if (seen.has(name)) throw invalid(`供应商 ${name} 写了两遍`);
      seen.add(name);
      // keys 不带就保留原来的；带了就整份替换：带 id 的是原有的（带了 key 就换值），不带 id 的是新加的。
      // 自定义供应商的接口地址换了域名、端口或协议：原来存的 key 作废，只留这次带了 key 的（ModelsConfig 的例外）
      const prev = before.get(name);
      const old = prev?.keys ?? [];
      const moved = prev !== undefined && !sameOrigin(prev.custom, p.custom);
      const given = moved ? (p.keys ?? []).filter((k) => k.id === undefined || k.key !== undefined) : (p.keys ?? old);
      const keys = given.map((k, i) => {
        const label = k.name?.trim() ? `「${k.name.trim()}」` : `第 ${i + 1} 个 key`;
        const value = k.key?.trim();
        if (k.key !== undefined && !value) throw invalid(`${name} 的${label}是空的：要删掉就把它从列表里拿掉`);
        if (k.id !== undefined && !old.some((o) => o.id === k.id))
          throw invalid(`${name} 的${label}已经不在了（可能在别处删掉了），刷新一下再改`);
        if (k.id === undefined && !value) throw invalid(`${name} 新加的${label}还没填 key`);
        const id = k.id ?? newId();
        if (value) this.keys.set(id, value);
        return { id, ...(k.name?.trim() ? { name: k.name.trim() } : {}), hasKey: this.keys.has(id) };
      });
      providers.push({
        provider: name,
        ...(p.custom ? { custom: structuredClone(p.custom) } : {}),
        keys,
        ...(p.rpm !== undefined ? { rpm: p.rpm } : {}),
        ...(p.tpm !== undefined ? { tpm: p.tpm } : {}),
      });
    }
    const kept = new Set(providers.flatMap((p) => (p.keys ?? []).map((k) => k.id)));
    for (const id of [...this.keys.keys()]) if (!kept.has(id)) this.keys.delete(id);
    this.models = { providers, strong: structuredClone(body.strong), fast: structuredClone(body.fast) };
    return this.getModels();
  }

  putSettings(body: Settings): Settings {
    const credentials: Settings['credentials'] = [];
    const keep = new Set<Id>();
    // 和 Melina 一样：有一条给不进容器的凭证就整份不收（src/config/store.ts，凭证白名单 469a4f3）
    for (const c of body.credentials) {
      const problem = credentialProblem(c);
      if (problem) throw invalid(problem);
    }
    for (const c of body.credentials) {
      const existing = c.id ? this.settings.credentials.find((x) => x.id === c.id) : undefined;
      if (c.id && !existing) throw invalid('没有这条凭证，可能已经删掉了');
      const id = existing?.id ?? newId();
      keep.add(id);
      if (c.value !== undefined) {
        if (c.value === '') this.secrets.delete(id);
        else this.secrets.set(id, c.value);
      }
      credentials.push({ id, name: c.name.trim(), as: c.as, hasValue: this.secrets.has(id) });
    }
    for (const id of [...this.secrets.keys()]) if (!keep.has(id)) this.secrets.delete(id);
    this.settings = {
      credentials,
      notify: body.notify,
      ...(body.config !== undefined
        ? { config: body.config }
        : this.settings.config
          ? { config: this.settings.config }
          : {}),
    };
    return this.getSettings();
  }

  /** 给测试看：存下来的 key 和凭证值（接口不回，只能在这里核对「只写」） */
  /** 每家按顺序的 key 值、凭证的值 */
  secretsForTest(): { keys: Record<string, string[]>; credentials: Record<string, string> } {
    const keys = Object.fromEntries(
      this.models.providers
        .map((p) => [p.provider, (p.keys ?? []).flatMap((k) => this.keys.get(k.id ?? '') ?? [])] as const)
        .filter(([, list]) => list.length > 0),
    );
    return { keys, credentials: Object.fromEntries(this.secrets) };
  }

  /** 断开所有 SSE 连接（测试断线续传用） */
  dropStreams(): void {
    for (const cb of this.resetListeners) cb();
  }

  private loadModels(kind: NonNullable<FakeOptions['models']>): void {
    const base: ModelsConfig =
      kind === 'two'
        ? MODELS_CONFIG
        : kind === 'single'
          ? MODELS_CONFIG_SINGLE
          : { providers: [], strong: [], fast: [] };
    this.keys.clear();
    for (const p of base.providers)
      (p.keys ?? []).forEach((k, i) => {
        if (k.hasKey && k.id) this.keys.set(k.id, `sk-fake-${p.provider}-${i + 1}`);
      });
    this.models = structuredClone(base);
  }

  private loadSettings(kind: NonNullable<FakeOptions['settings']>): void {
    this.secrets.clear();
    const base: Settings = kind === 'default' ? SETTINGS : { credentials: [], notify: true };
    for (const c of base.credentials) if (c.id && c.hasValue) this.secrets.set(c.id, `fake-secret-${c.name}`);
    this.settings = structuredClone(base);
  }

  private baseStatus(kind: 'ok' | 'trouble'): SystemStatus {
    const status = structuredClone(kind === 'ok' ? STATUS_OK : STATUS_TROUBLE);
    // 限流到什么时候：挪到一分半以后
    for (const p of status.providers) if (p.retryAt) p.retryAt = new Date(this.now() + 90_000).toISOString();
    return status;
  }
}
function sameOrigin(a: CustomProvider | undefined, b: CustomProvider | undefined): boolean {
  if (!a || !b) return !a && !b;
  const origin = (c: CustomProvider) => {
    try {
      return new URL(c.baseUrl.trim()).origin;
    } catch {
      return undefined;
    }
  };
  const before = origin(a);
  return before !== undefined && before === origin(b);
}
