// Melina 的 HTTP 客户端： 接口表的每个接口一个方法，请求和返回的类型都来自 src/core/api.ts。
// 只 import core 的类型；路径在这里抄一份，用类型和 core 的 API_ROUTES 对齐（改了 core 的路径，这里编译不过）。

import type {
  API_ROUTES,
  ApiError,
  BranchDetail,
  BranchDiffResponse,
  CreateRunRequest,
  CreateRunResponse,
  DirsResponse,
  InputRequest,
  InputResponse,
  ModelCatalogResponse,
  RunListResponse,
  RunResponse,
  RunResultResponse,
  RunSummary,
  StatusResponse,
  UsageResponse,
} from '../../../src/core/api.ts';
import type { ModelsConfig, Settings } from '../../../src/core/config.ts';
import type { Handle, Id } from '../../../src/core/ids.ts';

export const API_BASE = '/api';

type Routes = typeof API_ROUTES;
const ROUTES = {
  listRuns: { method: 'GET', path: '/runs' },
  createRun: { method: 'POST', path: '/runs' },
  dirs: { method: 'GET', path: '/dirs' },
  getRun: { method: 'GET', path: '/runs/:id' },
  runProgress: { method: 'GET', path: '/runs/:id/progress' },
  runEvents: { method: 'GET', path: '/runs/:id/events' },
  branch: { method: 'GET', path: '/runs/:id/branches/:branchId' },
  branchDiff: { method: 'GET', path: '/runs/:id/branches/:branchId/diff' },
  input: { method: 'POST', path: '/runs/:id/input' },
  pause: { method: 'POST', path: '/runs/:id/pause' },
  interrupt: { method: 'POST', path: '/runs/:id/interrupt' },
  resume: { method: 'POST', path: '/runs/:id/resume' },
  cancel: { method: 'POST', path: '/runs/:id/cancel' },
  deleteRun: { method: 'DELETE', path: '/runs/:id' },
  result: { method: 'GET', path: '/runs/:id/result' },
  artifact: { method: 'GET', path: '/runs/:id/artifacts/:hash' },
  events: { method: 'GET', path: '/events' },
  usage: { method: 'GET', path: '/usage' },
  status: { method: 'GET', path: '/status' },
  getModels: { method: 'GET', path: '/models' },
  putModels: { method: 'PUT', path: '/models' },
  modelCatalog: { method: 'GET', path: '/models/catalog' },
  getSettings: { method: 'GET', path: '/settings' },
  putSettings: { method: 'PUT', path: '/settings' },
} as const satisfies { [K in keyof Routes]: { method: Routes[K]['method']; path: Routes[K]['path'] } };
export type RouteName = keyof typeof ROUTES;

/** apiUrl('runProgress', { id }) → '/api/runs/<id>/progress' */
export function apiUrl(
  name: RouteName,
  params: Record<string, string> = {},
  query?: Record<string, string | number | undefined>,
): string {
  const path = ROUTES[name].path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`缺路径参数 ${key}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) search.set(k, String(v));
  const qs = search.toString();
  return API_BASE + path + (qs ? `?${qs}` : '');
}

export type ApiErrorCode = ApiError['error']['code'] | 'network';

/** 接口出错：code 照 core 的 ApiError；连不上 Melina 是 network */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'invalid',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  503: 'unavailable',
};

/**
 * 读接口最多等多久：Melina 卡住、或者电脑休眠后连接半开时，挂住的 GET 不会自己结束，
 * 这份数据就再也不刷新（资源缓存在途时只记「拉完再拉」）。写接口不设：建任务、上传附件可能就是要久
 */
export const GET_TIMEOUT_MS = 60_000;

async function request<T>(name: RouteName, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const method = ROUTES[name].method;
  const timeout =
    method === 'GET' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(GET_TIMEOUT_MS) : null;
  const signals = [signal, timeout].filter((x): x is AbortSignal => !!x);
  const combined = signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
  const init: RequestInit = { method, headers: { Accept: 'application/json' }, signal: combined };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout?.aborted)
      throw new ApiRequestError(0, 'network', `Melina ${GET_TIMEOUT_MS / 1000} 秒没回应：它可能卡住了，过一会儿再试。`);
    throw new ApiRequestError(0, 'network', NETWORK_MESSAGE);
  }
  if (res.status === 204) return undefined as T;
  return parseResponse<T>(res.status, await res.text());
}

const NETWORK_MESSAGE = '连不上 Melina：它可能没在运行，或者刚重启。';

/** 返回的正文 → 结果；不是 2xx 就按 core 的 ApiError 抛 ApiRequestError（fetch 和上传共用） */
function parseResponse<T>(status: number, text: string): T {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (status < 200 || status >= 300) {
    const err = (parsed as Partial<ApiError> | undefined)?.error;
    throw new ApiRequestError(
      status,
      err?.code ?? CODE_BY_STATUS[status] ?? 'internal',
      err?.message ?? `Melina 返回了错误（${status}）`,
      err?.details,
    );
  }
  return parsed as T;
}

/**
 * 发一个带文件的表单，能报上传了多少（fetch 拿不到上传进度，用 XMLHttpRequest）。附件大的时候（单个最多 2 GiB）
 * 「开始」要转好一会儿，以前看不出是在传还是卡住了
 */
function upload<T>(name: RouteName, url: string, form: FormData, onProgress?: (sent: number, total: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ROUTES[name].method, url);
    xhr.setRequestHeader('Accept', 'application/json');
    if (onProgress)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    xhr.onerror = () => reject(new ApiRequestError(0, 'network', NETWORK_MESSAGE));
    xhr.onload = () => {
      try {
        resolve(xhr.status === 204 ? (undefined as T) : parseResponse<T>(xhr.status, xhr.responseText));
      } catch (error) {
        reject(error);
      }
    };
    xhr.send(form);
  });
}

/**  接口表 */
export const api = {
  listRuns: (signal?: AbortSignal) => request<RunListResponse>('listRuns', apiUrl('listRuns'), undefined, signal),

  /** 有附件就发 multipart（run 字段放 JSON，附件放 materials，保留原文件名），没有就发 JSON */
  createRun(
    req: CreateRunRequest,
    materials: readonly File[] = [],
    onProgress?: (sent: number, total: number) => void,
  ) {
    if (materials.length === 0) return request<CreateRunResponse>('createRun', apiUrl('createRun'), req);
    const form = new FormData();
    form.append('run', JSON.stringify(req));
    for (const file of materials) form.append('materials', file, file.name);
    return upload<CreateRunResponse>('createRun', apiUrl('createRun'), form, onProgress);
  },

  dirs: (prefix: string, signal?: AbortSignal) =>
    request<DirsResponse>('dirs', apiUrl('dirs', {}, { prefix }), undefined, signal),
  getRun: (id: Id, signal?: AbortSignal) => request<RunSummary>('getRun', apiUrl('getRun', { id }), undefined, signal),
  branch: (id: Id, branchId: Id, page: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<BranchDetail>('branch', apiUrl('branch', { id, branchId }, page), undefined, signal),
  /** 一条路线现在（lastSnapshot）相对起点的改动；没有改动时没有 patch。任务没结束也能看 */
  branchDiff: (id: Id, branchId: Id, signal?: AbortSignal) =>
    request<BranchDiffResponse>('branchDiff', apiUrl('branchDiff', { id, branchId }), undefined, signal),
  input: (id: Id, input: InputRequest) => request<InputResponse>('input', apiUrl('input', { id }), input),
  pause: (id: Id) => request<RunResponse>('pause', apiUrl('pause', { id })),
  resume: (id: Id) => request<RunResponse>('resume', apiUrl('resume', { id })),
  cancel: (id: Id) => request<RunResponse>('cancel', apiUrl('cancel', { id })),
  deleteRun: (id: Id) => request<void>('deleteRun', apiUrl('deleteRun', { id })),
  result: (id: Id, signal?: AbortSignal) =>
    request<RunResultResponse>('result', apiUrl('result', { id }), undefined, signal),
  usage: (signal?: AbortSignal) => request<UsageResponse>('usage', apiUrl('usage'), undefined, signal),
  status: (signal?: AbortSignal) => request<StatusResponse>('status', apiUrl('status'), undefined, signal),
  getModels: (signal?: AbortSignal) => request<ModelsConfig>('getModels', apiUrl('getModels'), undefined, signal),
  /** DeepSeek 模型目录（模型页加模型的下拉）；价格是每百万 token 的美元 */
  modelCatalog: (signal?: AbortSignal) =>
    request<ModelCatalogResponse>('modelCatalog', apiUrl('modelCatalog'), undefined, signal),
  /** 返回存下来的样子（同 GET）；Melina 只回 204 时再 GET 一次 */
  putModels: async (models: ModelsConfig): Promise<ModelsConfig> =>
    (await request<ModelsConfig | undefined>('putModels', apiUrl('putModels'), models)) ?? api.getModels(),
  getSettings: (signal?: AbortSignal) => request<Settings>('getSettings', apiUrl('getSettings'), undefined, signal),
  putSettings: async (settings: Settings): Promise<Settings> =>
    (await request<Settings | undefined>('putSettings', apiUrl('putSettings'), settings)) ?? api.getSettings(),
};

/** 原始产物的地址（GET /runs/:id/artifacts/:hash）。Melina 一律当纯文本或附件返回，不在本站渲染 */
export function artifactUrl(runId: Id, handle: Handle): string {
  return apiUrl('artifact', { id: runId, hash: handle.slice('art://'.length) });
}

/** 读文本产物（交付的文档、知识报告、patch），给页面自己消毒后显示 */
export async function fetchArtifactText(runId: Id, handle: Handle, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(artifactUrl(runId, handle), { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiRequestError(0, 'network', '连不上 Melina：它可能没在运行，或者刚重启。');
  }
  if (!res.ok) throw new ApiRequestError(res.status, CODE_BY_STATUS[res.status] ?? 'internal', '读不到这个产物');
  return res.text();
}

/** 两条 SSE 流的地址：全局的（总览、角标、通知用）和单个 Run 的（工作台页用） */
export const streamUrl = {
  all: (since?: number) => apiUrl('events', {}, { since }),
  run: (id: Id, since?: number) => apiUrl('runEvents', { id }, { since }),
};
