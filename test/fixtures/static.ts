// 不跟 Run 走的几个 GET 返回：模型页、模型目录、设置页、系统状态、工作目录补全、用量。给假后端用。

import type { DirsResponse, ModelCatalogResponse, UsageResponse } from '../../src/core/api.ts';
import type { ModelsConfig, Settings } from '../../src/core/config.ts';
import type { SystemStatus } from '../../src/core/events.ts';
import { MODELS } from './runs/index.ts';

/** 模型页上几个 API key 的 id */
export const KEY_IDS = {
  deepseekCompany: '01K6F1W3S2A8Q0Q6YH7J5M4K01',
  deepseekPersonal: '01K6F1W3S2A8Q0Q6YH7J5M4K02',
  anthropic: '01K6F1W3S2A8Q0Q6YH7J5M4K03',
} as const;

/** GET /models：两家官方接口，DeepSeek 配了两个账号的 key（首选加备用）；key 不回，只回 hasKey */
export const MODELS_CONFIG: ModelsConfig = {
  providers: [
    {
      provider: 'deepseek',
      keys: [
        { id: KEY_IDS.deepseekCompany, name: '公司账号', hasKey: true },
        { id: KEY_IDS.deepseekPersonal, name: '个人账号', hasKey: true },
      ],
    },
    { provider: 'anthropic', keys: [{ id: KEY_IDS.anthropic, hasKey: true }], rpm: 1000 },
  ],
  strong: [MODELS.strong, MODELS.strongAlt],
  fast: [MODELS.fast, MODELS.fastAlt],
};

/** 只配了一个供应商的模型页：前端要提示「只配了一家供应商」 */
export const MODELS_CONFIG_SINGLE: ModelsConfig = {
  providers: [{ provider: 'deepseek', keys: [{ id: KEY_IDS.deepseekCompany, name: '公司账号', hasKey: true }] }],
  strong: [MODELS.strong],
  fast: [MODELS.fast],
};

/** GET /settings：凭证的 value 不回，只回 hasValue */
export const SETTINGS: Settings = {
  credentials: [
    { id: '01K6F1W3S2A8Q0Q6YH7J5M4N3P', name: 'GitHub 只读 token', as: { env: 'GITHUB_TOKEN' }, hasValue: true },
    {
      id: '01K6F1W3S2A8Q0Q6YH7J5M4N3Q',
      name: '测试库的连接串',
      as: { file: '/run/secrets/test-db.url' },
      hasValue: true,
    },
  ],
  notify: true,
};

/** GET /status：一切正常 */
export const STATUS_OK: SystemStatus = {
  providers: [
    {
      provider: 'deepseek',
      breaker: 'ok',
      limit: null,
      inFlight: 3,
      queued: 0,
      episodes: { running: 2, queued: 1 },
      keys: [
        { id: KEY_IDS.deepseekCompany, name: '公司账号', state: 'active' },
        { id: KEY_IDS.deepseekPersonal, name: '个人账号', state: 'standby' },
      ],
    },
    {
      provider: 'anthropic',
      breaker: 'ok',
      limit: null,
      inFlight: 1,
      queued: 0,
      episodes: { running: 1, queued: 0 },
      keys: [{ id: KEY_IDS.anthropic, state: 'active' }],
    },
  ],
  toolExec: { limit: 3, running: 3, queued: 1, auto: true },
  disk: { freeBytes: 120 * 1024 ** 3, minBytes: 10 * 1024 ** 3, ok: true },
  runs: { running: 2, paused: 1 },
};

/** GET /status：一家熔断（换到了备用模型，首选的 key 余额不足、换到了备用 key）、一家被限流、磁盘不够（不再启动新分支） */
export const STATUS_TROUBLE: SystemStatus = {
  providers: [
    {
      provider: 'deepseek',
      breaker: 'open',
      reason: '连续 3 次超时（15 分钟没收到新内容）',
      limit: 4,
      inFlight: 0,
      queued: 2,
      episodes: { running: 0, queued: 2 },
      fallbackTo: MODELS.fastAlt,
      keys: [
        { id: KEY_IDS.deepseekCompany, name: '公司账号', state: 'down', reason: '402：Insufficient Balance' },
        { id: KEY_IDS.deepseekPersonal, name: '个人账号', state: 'active' },
      ],
    },
    {
      provider: 'anthropic',
      breaker: 'ok',
      limit: 6,
      inFlight: 6,
      queued: 3,
      episodes: { running: 2, queued: 1 },
      retryAt: '2026-10-01T09:15:30.000Z',
      keys: [{ id: KEY_IDS.anthropic, state: 'active' }],
    },
  ],
  toolExec: { limit: 2, running: 2, queued: 3, auto: true },
  disk: { freeBytes: 7 * 1024 ** 3, minBytes: 10 * 1024 ** 3, ok: false },
  runs: { running: 3, paused: 0 },
  notices: [
    {
      kind: 'disk',
      level: 'error',
      text: '磁盘只剩 7 GB，低于 10 GB 的下限：不再启动新的路线，在跑的不受影响，腾出空间后自动恢复。',
    },
    {
      kind: 'images',
      level: 'error',
      text: 'code 领域的镜像还没建：先跑 pnpm images code，不然写代码的任务起不了路线。',
    },
  ],
};

/** GET /dirs?prefix=/home/me/ */
export const DIRS: DirsResponse = {
  dir: '/home/me',
  entries: [
    { name: 'api-server', path: '/home/me/api-server', git: true },
    { name: 'legacy-billing', path: '/home/me/legacy-billing', git: true },
    { name: 'notes', path: '/home/me/notes', git: false },
    { name: 'shop-api', path: '/home/me/shop-api', git: true },
  ],
  truncated: false,
  recent: [
    { name: 'legacy-billing', path: '/home/me/legacy-billing', git: true },
    { name: 'api-server', path: '/home/me/api-server', git: true },
    { name: 'shop-api', path: '/home/me/shop-api', git: true },
  ],
};

/** GET /usage */
export const USAGE: UsageResponse = {
  total: { input: 3_920_000, cacheRead: 2_610_000, cacheWrite: 0, output: 318_000, usd: 27.4 },
  byModel: [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      input: 2_100_000,
      cacheRead: 1_500_000,
      cacheWrite: 0,
      output: 170_000,
      usd: 14.9,
    },
    {
      provider: 'deepseek',
      model: 'deepseek-flash',
      input: 900_000,
      cacheRead: 600_000,
      cacheWrite: 0,
      output: 70_000,
      usd: 1.8,
    },
    {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      input: 620_000,
      cacheRead: 380_000,
      cacheWrite: 0,
      output: 52_000,
      usd: 8.9,
    },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      input: 300_000,
      cacheRead: 130_000,
      cacheWrite: 0,
      output: 26_000,
      usd: 1.8,
    },
  ],
  byRole: [
    { role: 'scoper', input: 900_000, cacheRead: 540_000, cacheWrite: 0, output: 87_000, usd: 7.5 },
    { role: 'explorer', input: 2_900_000, cacheRead: 2_050_000, cacheWrite: 0, output: 221_000, usd: 19.1 },
    { role: 'scoper', input: 120_000, cacheRead: 20_000, cacheWrite: 0, output: 10_000, usd: 0.8 },
  ],
  byDay: [
    { day: '2026-09-28', input: 500_000, cacheRead: 330_000, cacheWrite: 0, output: 46_000, usd: 3.3 },
    { day: '2026-09-29', input: 1_990_000, cacheRead: 1_400_000, cacheWrite: 0, output: 152_000, usd: 15.1 },
    { day: '2026-09-30', input: 1_100_000, cacheRead: 680_000, cacheWrite: 0, output: 96_000, usd: 7.4 },
    { day: '2026-10-01', input: 330_000, cacheRead: 200_000, cacheWrite: 0, output: 24_000, usd: 1.6 },
  ],
};

/**
 * GET /models/catalog：Melina 能用的模型目录（模型页「加一家供应商」「加模型」的选择面板）。只列了几家里的几个，
 * 名字和接口地址照 pi 1.0.0 写；价格是每百万 token 的美元；hasKey 由假后端按模型页里配没配 key 改写
 */
export const MODEL_CATALOG: ModelCatalogResponse = {
  providers: [
    {
      provider: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      hasKey: true,
      models: [
        {
          model: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          contextWindow: 200_000,
          maxOutput: 64_000,
          reasoning: true,
          price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        },
        {
          model: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          contextWindow: 200_000,
          maxOutput: 64_000,
          reasoning: true,
          price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
        {
          model: 'claude-haiku-4-5-20251001',
          name: 'Claude Haiku 4.5',
          contextWindow: 200_000,
          maxOutput: 64_000,
          reasoning: false,
          price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        },
      ],
    },
    {
      provider: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      hasKey: true,
      models: [
        {
          model: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          contextWindow: 128_000,
          maxOutput: 32_000,
          reasoning: true,
          price: { input: 0.56, output: 1.68, cacheRead: 0.07 },
        },
        {
          model: 'deepseek-flash',
          name: 'DeepSeek V4.1 Flash',
          contextWindow: 128_000,
          maxOutput: 16_000,
          reasoning: false,
          price: { input: 0.14, output: 0.28, cacheRead: 0.02 },
        },
      ],
    },
    {
      provider: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      hasKey: false,
      models: [
        {
          model: 'gpt-5.2',
          name: 'GPT-5.2',
          contextWindow: 400_000,
          maxOutput: 128_000,
          reasoning: true,
          price: { input: 1.25, output: 10, cacheRead: 0.125 },
        },
      ],
    },
    {
      provider: 'zai-coding-cn',
      name: 'Z.AI Coding CN',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      hasKey: false,
      models: [
        { model: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true },
        {
          model: 'glm-5.3-flash',
          name: 'GLM-5.3 Flash',
          contextWindow: 1_000_000,
          maxOutput: 131_072,
          reasoning: true,
        },
      ],
    },
    {
      provider: 'kimi-coding',
      name: 'Kimi For Coding',
      baseUrl: 'https://api.kimi.com/coding',
      hasKey: false,
      models: [
        {
          model: 'kimi-for-coding',
          name: 'Kimi For Coding',
          contextWindow: 1_048_576,
          maxOutput: 32_768,
          reasoning: true,
        },
      ],
    },
    {
      provider: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      hasKey: false,
      models: [
        {
          model: 'deepseek/deepseek-v4-pro',
          name: 'DeepSeek: DeepSeek V4 Pro',
          contextWindow: 1_000_000,
          maxOutput: 384_000,
          reasoning: true,
          price: { input: 0.6, output: 1.8 },
        },
        {
          model: 'qwen/qwen3.7-max',
          name: 'Qwen: Qwen3.7 Max',
          contextWindow: 1_000_000,
          maxOutput: 131_072,
          reasoning: true,
          price: { input: 1.2, output: 6 },
        },
      ],
    },
  ],
};
