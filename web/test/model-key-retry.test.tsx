// @vitest-environment jsdom
// 用不了的 key 不再每分钟试。有别的顶着（后面的 key、备用模型）时越隔越久、最长一小时；
// 一家的 key 都用不了、又没有备用模型时调用在排队，还是每分钟试。总览和模型页照实说，解不开的 key 不说会再试。

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelsConfig } from '../../src/core/config.ts';
import type { ProviderStatus, SystemStatus } from '../../src/core/events.ts';
import { setResource, subscribeResource } from '../src/api/resource.ts';
import { MODELS, STATUS } from '../src/api/resources.ts';
import { keysNote } from '../src/lib/labels.ts';
import { ModelsPage } from '../src/pages/models/ModelsPage.tsx';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const K1 = '01M3K1K1K1K1K1K1K1K1K1K1K1';
const K2 = '01M3K2K2K2K2K2K2K2K2K2K2K2';
const WEEKLY = "403：You've reached your weekly (7-day) usage limit";

function provider(over: Partial<ProviderStatus>): ProviderStatus {
  return {
    provider: 'kimi-coding',
    breaker: 'ok',
    limit: null,
    inFlight: 0,
    queued: 0,
    episodes: { running: 0, queued: 0 },
    ...over,
  };
}

/** 模型页上 kimi-coding 配了两个 key，状况按 p 给，渲染出来的纯文字 */
function modelsPageText(p: ProviderStatus, hasKey = true): string {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch; // 数据由 setResource 放进去
  const config: ModelsConfig = {
    providers: [
      {
        provider: 'kimi-coding',
        keys: [
          { id: K1, name: '主账号', hasKey },
          { id: K2, name: '备用账号', hasKey: true },
        ],
      },
    ],
    strong: [{ provider: 'kimi-coding', model: 'k3', tier: 'strong' }],
    fast: [{ provider: 'kimi-coding', model: 'k3', tier: 'fast' }],
  };
  const status: SystemStatus = {
    providers: [p],
    toolExec: { limit: 2, running: 0, queued: 0, auto: false },
    disk: { freeBytes: 50 * 1024 ** 3, minBytes: 10 * 1024 ** 3, ok: true },
    runs: { running: 0, paused: 0 },
  };
  const stops = [subscribeResource(MODELS, () => {}), subscribeResource(STATUS, () => {})];
  setResource(MODELS.key, config);
  setResource(STATUS.key, status);
  const html = renderToStaticMarkup(<ModelsPage />);
  for (const stop of stops) stop();
  return html.replace(/<[^>]+>/g, '');
}

describe('用不了的 key 多久再试', () => {
  it('总览：首选用不了、备用在顶着，说越隔越久、最长一小时，不再说每分钟', () => {
    const note = keysNote([
      { id: K1, name: '主账号', state: 'down', reason: WEEKLY },
      { id: K2, name: '备用账号', state: 'active' },
    ]);
    expect(note).toContain('现在用「备用账号」');
    expect(note).toContain('过一阵再试，一直不行就隔得越来越久（最长一小时），好了就换回去。');
    expect(note).not.toContain('每分钟');
  });

  it('模型页：备用 key 在顶着时越隔越久', () => {
    const text = modelsPageText(
      provider({
        keys: [
          { id: K1, name: '主账号', state: 'down', reason: WEEKLY },
          { id: K2, name: '备用账号', state: 'active' },
        ],
      }),
    );
    expect(text).toContain('过一阵再试，一直不行就隔得越来越久（最长一小时），好了就用回它。');
    expect(text).not.toContain('每分钟试一次');
  });

  it('模型页：key 都用不了、换到了备用模型，也是越隔越久', () => {
    const text = modelsPageText(
      provider({
        breaker: 'open',
        reason: '2 个 API key 都用不了',
        fallbackTo: { provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' },
        keys: [
          { id: K1, name: '主账号', state: 'down', reason: WEEKLY },
          { id: K2, name: '备用账号', state: 'down', reason: WEEKLY },
        ],
      }),
    );
    expect(text).toContain('隔得越来越久（最长一小时）');
    expect(text).not.toContain('每分钟试一次');
  });

  it('模型页：key 都用不了、没有备用模型，调用在排队，每分钟试', () => {
    const text = modelsPageText(
      provider({
        breaker: 'open',
        reason: '2 个 API key 都用不了',
        keys: [
          { id: K1, name: '主账号', state: 'down', reason: WEEKLY },
          { id: K2, name: '备用账号', state: 'down', reason: WEEKLY },
        ],
      }),
    );
    expect(text).toContain('这家的调用在排队，每分钟试一次，好了就用回它。');
    expect(text).not.toContain('最长一小时');
  });

  it('模型页：解不开的 key 只说要重新填，不说会再试', () => {
    const text = modelsPageText(
      provider({
        keys: [
          { id: K1, name: '主账号', state: 'down', reason: '存着的 key 解不开（密钥换过），要在模型页重新填' },
          { id: K2, name: '备用账号', state: 'active' },
        ],
      }),
      false,
    );
    expect(text).toContain('用不了：存着的 key 解不开（密钥换过），要在模型页重新填。');
    expect(text).not.toContain('过一阵再试');
    expect(text).not.toContain('每分钟试一次');
  });
});
