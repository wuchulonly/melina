// HTTP 接口。用 Hono 写，进程入口（cli.ts）用 @hono/node-server 跑。
//
// 只做 HTTP 这一层：校验请求、调接口、按 MelinaError 的 code 换状态码（core/api.ts 的 HTTP_STATUS），出错一律回 ApiError。

// 模型和设置的读写交给配置存储。哪一样都通过 ApiDeps 给进来，测试里换成假的。
//
// 和前端对齐的几处：POST /runs 回 201；DELETE /runs/:id 回 204 空 body；pause、resume、cancel 不带 body；
// SSE 不带 since 也没有 Last-Event-ID 时只推新事件；/api 以外认不出的 GET 路径回前端的 index.html。
//
// 大的 JSON 响应 gzip（compress.ts），
// SSE 和产物下载不压。

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { type Context, Hono } from 'hono';
import {
  API_BASE,
  API_ROUTES,
  type ApiError,
  type BranchDiffResponse,
  CreateRunRequest,
  type CreateRunResponse,
  HTTP_STATUS,
  InputRequest,
  type InputResponse,
  type ModelCatalogResponse,
  type RunListResponse,
  type RunResponse,
  SSE_HEARTBEAT_MS,
} from '../core/api.ts';
import { ModelsConfig, Settings } from '../core/config.ts';
import { conflict, type ErrorCode, invalid, isMelinaError, type MelinaError, notFound } from '../core/errors.ts';
import type { SystemStatus } from '../core/events.ts';
import { handleFromSha256, type Id, isId } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { ConfigStore } from '../core/interfaces/config-store.ts';
import type { RunManager } from '../core/interfaces/runtime.ts';
import type { EventBus, RunStoreQueries } from '../core/interfaces/store.ts';
import { check } from '../core/validate.ts';
import { runProgress } from '../projections/run-progress.ts';
import { runList, runResult, runSummary } from '../projections/views.ts';
import { type AccessPolicy, checkAccess } from './access.ts';
import { compressJson } from './compress.ts';
import { checkWorkspaceRoot, listDirs } from './dirs.ts';
import { DEFAULT_UPLOAD_LIMITS, readMultipart, type UploadLimits } from './multipart.ts';
import { parseSince, SSE_HEADERS, sseStream } from './sse.ts';
import { serveWeb } from './static.ts';

export interface ApiDeps {
  queries: RunStoreQueries;
  bus: EventBus;
  artifacts: ArtifactStore;
  runs: RunManager;
  config: Pick<ConfigStore, 'getModels' | 'getSettings'>;
  /** PUT /models：Melina 先查供应商和模型在不在 DeepSeek 目录里，再交给配置存储 */
  putModels(config: ModelsConfig): ModelsConfig;
  putSettings(settings: Settings): Settings;
  status(): SystemStatus;
  /** GET /models/catalog：DeepSeek 模型目录（模型页做下拉） */
  modelCatalog(): ModelCatalogResponse;
  /** GET /runs/:id/branches/:branchId/diff：路线到上次收尾为止相对起点的改动；Run 或路线不存在抛 not_found */
  branchDiff(runId: Id, branchId: Id): Promise<BranchDiffResponse>;
  access: AccessPolicy;
  /** Melina 的数据目录（Artifact store、workspace 等）：GET /dirs 不列，也不许当工作目录 */
  protectedDirs: readonly string[];
  /** 上传附件的临时目录 */
  uploadDir: string;
  uploadLimits?: UploadLimits;
  /** 前端打包出来的 dist 目录；不给就只在首页放一段说明 */
  web?: string;
  /** GET /dirs 的 ~，默认当前用户的 home */
  home?: string;
  heartbeatMs?: number;
  /** 500 的详细原因记日志，不回给前端 */
  onError?: (error: unknown) => void;
}

/** JSON 请求体的上限：凭证可能是一整个 kubeconfig、证书 */
export const MAX_JSON_BYTES = 4 * 1024 ** 2;
const HASH = /^[0-9a-f]{64}$/;
const ROUTE_MATCHERS = Object.values(API_ROUTES).map((r) => ({
  method: r.method as string,
  re: new RegExp(`^${API_BASE}${r.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`),
}));

export function createApp(deps: ApiDeps): Hono {
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const app = new Hono();

  app.onError((error, c) => sendError(c, error, deps.onError));

  app.use('*', async (c, next) => {
    checkAccess(deps.access, {
      method: c.req.method,
      path: c.req.path,
      host: c.req.header('host'),
      origin: c.req.header('origin'),
      secFetchSite: c.req.header('sec-fetch-site'),
      secFetchMode: c.req.header('sec-fetch-mode'),
    });
    await next();
  });

  const api = new Hono();
  // 先挂上：Hono 按注册的先后跑，挂在路由后面的中间件轮不到
  api.use('*', compressJson());

  // ── 任务 ──────────────────────────────────────────────────────────────

  api.get('/runs', (c) => c.json({ runs: runList(deps.queries) } satisfies RunListResponse, 200, noStore));

  api.post('/runs', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let body: unknown;
    let materials: { name: string; path: string }[] = [];
    let cleanup: (() => Promise<void>) | undefined;
    try {
      if (contentType.toLowerCase().startsWith('multipart/form-data')) {
        const form = await readMultipart(c.req.raw, deps.uploadDir, deps.uploadLimits ?? DEFAULT_UPLOAD_LIMITS);
        cleanup = form.cleanup;
        const raw = form.fields.run;
        if (raw === undefined) throw invalid('缺少 run 字段（新建任务的请求，JSON）');
        body = parseJson(raw, 'run 字段');
        materials = form.files.map((f) => ({ name: f.name, path: f.path }));
      } else {
        body = await readJson(c.req.raw);
      }
      const req = check(CreateRunRequest, body, '新建任务的请求');
      if (req.continueFrom !== undefined && req.workspace !== undefined) {
        throw invalid('接着做时不传工作目录：照上个任务的来');
      }
      if (req.continueFrom !== undefined && !deps.queries.getRun(req.continueFrom)) {
        throw invalid(`接着做的任务不存在：${req.continueFrom}`); // 引用的 id 不存在算 invalid（core/errors.ts）
      }
      const workspace =
        req.workspace !== undefined
          ? await checkWorkspaceRoot(req.workspace, deps.protectedDirs, deps.home)
          : undefined;
      const run = await deps.runs.create({ ...req, ...(workspace !== undefined ? { workspace } : {}), materials });
      return c.json({ runId: run.id } satisfies CreateRunResponse, 201, noStore);
    } finally {
      await cleanup?.();
    }
  });

  api.get('/dirs', async (c) => {
    const recent = deps.queries.listRuns().map((r) => r.workspace.root);
    const result = await listDirs(c.req.query('prefix') ?? '', {
      protectedDirs: deps.protectedDirs,
      recent,
      ...(deps.home !== undefined ? { home: deps.home } : {}),
    });
    return c.json(result, 200, noStore);
  });

  api.get('/runs/:id', (c) => {
    const summary = runSummary(deps.queries, runIdOf(c));
    if (!summary) throw noRun(c);
    return c.json(summary, 200, noStore);
  });

  api.get('/runs/:id/events', (c) => {
    const runId = runIdOf(c);
    if (!deps.queries.getRun(runId)) throw noRun(c);
    return sse(c, runId);
  });

  api.get('/runs/:id/progress', (c) => {
    const run = deps.queries.getRun(runIdOf(c));
    if (!run) throw noRun(c);
    return c.json(runProgress(deps.queries, run), 200, noStore);
  });

  api.get('/runs/:id/branches/:branchId', (c) => {
    const runId = runIdOf(c);
    const branchId = c.req.param('branchId');
    const limitText = c.req.query('limit');
    let limit: number | undefined;
    if (limitText !== undefined) {
      limit = Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('limit 要是 1 到 200 的整数');
    }
    const cursor = c.req.query('cursor');
    if (!deps.queries.getRun(runId)) throw noRun(c);
    const detail = deps.queries.branchDetail(runId, branchId, {
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!detail) throw notFound(`这个任务里没有这条路线：${branchId}`);
    return c.json(detail, 200, noStore);
  });

  // 在跑的路线现在改成了什么样（工作台页的「改动」标签，任务没结束也能看）：patch 是句柄，内容照产物取
  api.get('/runs/:id/branches/:branchId/diff', async (c) => {
    const runId = runIdOf(c);
    const branchId = c.req.param('branchId');
    if (!deps.queries.getRun(runId)) throw noRun(c);
    if (!isId(branchId)) throw notFound(`这个任务里没有这条路线：${branchId}`);
    return c.json(await deps.branchDiff(runId, branchId), 200, noStore);
  });

  // ── 人介入 ────────────────────────────────────────────────────────────

  api.post('/runs/:id/input', async (c) => {
    const runId = runIdOf(c);
    const req = check(InputRequest, await readJson(c.req.raw), '输入');
    if (!deps.queries.getRun(runId)) throw noRun(c);
    const input = await deps.runs.input(runId, req);
    return c.json({ input } satisfies InputResponse, 200, noStore);
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    api.post(`/runs/:id/${action}`, async (c) => {
      const runId = runIdOf(c);
      if (!deps.queries.getRun(runId)) throw noRun(c);
      const run = await deps.runs[action](runId);
      return c.json({ run } satisfies RunResponse, 200, noStore);
    });
  }

  api.post('/runs/:id/interrupt', async (c) => {
    const runId = runIdOf(c);
    if (!deps.queries.getRun(runId)) throw noRun(c);
    if (!deps.runs.interrupt) throw conflict('这个运行时不支持宿主立即暂停，不能确认在途进程已停止');
    const run = await deps.runs.interrupt(runId);
    return c.json({ run } satisfies RunResponse, 200, noStore);
  });

  api.delete('/runs/:id', async (c) => {
    const runId = runIdOf(c);
    if (!deps.queries.getRun(runId)) throw noRun(c);
    await deps.runs.delete(runId);
    return c.body(null, 204);
  });

  // ── 结果和产物 ────────────────────────────────────────────────────────

  api.get('/runs/:id/result', (c) => {
    const runId = runIdOf(c);
    const run = deps.queries.getRun(runId);
    if (!run) throw noRun(c);
    const result = runResult(deps.queries, runId);
    if (!result) throw conflict('任务还没结束，结束了才有结果');
    return c.json(result, 200, noStore);
  });

  api.get('/runs/:id/artifacts/:hash', async (c) => {
    const runId = runIdOf(c);
    const hash = c.req.param('hash').toLowerCase();
    if (!HASH.test(hash)) throw invalid('产物的地址不对：要 64 位十六进制的 sha256');
    if (!deps.queries.getRun(runId)) throw noRun(c);
    const handle = handleFromSha256(hash);
    const size = (await deps.artifacts.stat(runId, handle))?.size;
    if (size === undefined) throw notFound(`这个任务里没有产物 ${handle}`);
    return artifactResponse(deps.artifacts.path(runId, handle), size, c.req.method === 'HEAD');
  });

  // ── 全局 ──────────────────────────────────────────────────────────────

  api.get('/events', (c) => sse(c));
  api.get('/usage', (c) => c.json(deps.queries.usageReport(), 200, noStore));
  api.get('/status', (c) => c.json(deps.status(), 200, noStore));

  api.get('/models', (c) => c.json(deps.config.getModels(), 200, noStore));
  api.get('/models/catalog', (c) => c.json(deps.modelCatalog(), 200, noStore));
  api.put('/models', async (c) => {
    const config = check(ModelsConfig, await readJson(c.req.raw), '模型配置');
    return c.json(deps.putModels(config), 200, noStore);
  });
  api.get('/settings', (c) => c.json(deps.config.getSettings(), 200, noStore));
  api.put('/settings', async (c) => {
    const settings = check(Settings, await readJson(c.req.raw), '设置');
    return c.json(deps.putSettings(settings), 200, noStore);
  });

  // /api 下没对上的：路径对得上、方法不对的说清楚
  api.all('*', (c) => {
    const path = c.req.path;
    if (ROUTE_MATCHERS.some((m) => m.re.test(path))) throw invalid(`这个接口不接受 ${c.req.method}`);
    throw notFound(`没有这个接口：${c.req.method} ${path}`);
  });

  app.route(API_BASE, api);

  // ── 前端 ──────────────────────────────────────────────────────────────

  app.all('*', async (c) => {
    const res = await serveWeb(deps.web, c.req.path, c.req.method);
    if (res) return res;
    throw notFound(`没有这个页面：${c.req.path}`);
  });

  return app;

  function sse(c: Context, runId?: Id): Response {
    const since = parseSince(c.req.query('since'), c.req.header('last-event-id'));
    if (since === null) throw invalid('since 要是非负整数（事件的 seq）');
    const stream = sseStream({
      bus: deps.bus,
      since: since ?? deps.queries.lastSeq(),
      ...(runId !== undefined ? { runId } : {}),
      signal: c.req.raw.signal,
      heartbeatMs,
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }
}

const noStore = { 'Cache-Control': 'no-store' };

function runIdOf(c: Context): Id {
  const id = c.req.param('id') ?? '';
  if (!isId(id)) throw notFound(`没有这个任务：${id}`);
  return id;
}

function noRun(c: Context): MelinaError {
  return notFound(`没有这个任务：${c.req.param('id')}`);
}

function sendError(c: Context, error: unknown, onError?: (error: unknown) => void): Response {
  let code: ErrorCode = 'internal';
  let message = 'Melina 内部出错了，详情在 Melina 的日志里';
  let details: unknown;
  if (isMelinaError(error)) {
    code = error.code;
    message = error.message;
    details = error.details;
    if (code === 'internal') onError?.(error);
  } else {
    onError?.(error);
  }
  const body: ApiError = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return c.json(body, HTTP_STATUS[code] as 400, noStore);
}

/** 读 JSON 请求体，最多 MAX_JSON_BYTES；空的当 undefined */
async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? Number.NaN);
  if (length > MAX_JSON_BYTES) throw invalid(`请求体太大：最多 ${MAX_JSON_BYTES / 1024 ** 2} MiB`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) throw invalid(`请求体太大：最多 ${MAX_JSON_BYTES / 1024 ** 2} MiB`);
      chunks.push(chunk);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  return parseJson(text, '请求体');
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`${what}不是合法的 JSON`);
  }
}

/**
 * 原始产物：一律当纯文本或附件下载返回，带 nosniff 和 CSP sandbox，产物里的脚本不能在 Melina 的源上执行。
 * 开头 8 KiB 是合法的 UTF-8、没有 NUL 就当纯文本，否则当附件。内容寻址，可以长缓存。
 */
async function artifactResponse(path: string, size: number, head: boolean): Promise<Response> {
  const text = await looksLikeText(path);
  const headers: Record<string, string> = {
    'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=31536000, immutable',
    ...(text ? {} : { 'Content-Disposition': 'attachment' }),
  };
  const body = head ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>);
  return new Response(body, { status: 200, headers });
}

async function looksLikeText(path: string): Promise<boolean> {
  const fd = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const sample = buf.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true }); // stream：末尾切断的多字节字符不算错
      return true;
    } catch {
      return false;
    }
  } finally {
    await fd.close();
  }
}
