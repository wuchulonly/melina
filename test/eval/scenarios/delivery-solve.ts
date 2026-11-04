// 通过业务接口比较副本、素材解析结果和已发布版本，不读取隐藏规则。
import type { SolveContext } from '../../sim/task.ts';
import { Investigator } from './client.ts';

export async function solveCache(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { product_id: string; requested_price_cents: number } }>();
  const api = await c.get<{
    product: string;
    edge: string;
    compatibility_suffixes: string[];
    regions: string[];
    region_header: string;
    consistency_query: string;
    invalidate: string;
    scopes: string[];
  }>('/api');
  await c.get(api.product);
  for (const suffix of api.compatibility_suffixes)
    for (const region of api.regions) await c.get(`${api.edge}${suffix}`, { [api.region_header]: region });
  const update = await c.call<{ revision: number }>('PUT', api.product, {
    price_cents: h.target.requested_price_cents,
  });
  let stalePath: string | undefined;
  for (const suffix of api.compatibility_suffixes) {
    const path = `${api.edge}${suffix}`;
    const response = await c.call('GET', `${path}?${api.consistency_query}=${update.body.revision}`, undefined, {
      [api.region_header]: api.regions[0]!,
    });
    if (response.status === 409) stalePath = path;
  }
  if (!stalePath) throw new Error('没有观察到陈旧的缓存副本');
  await c.call('POST', api.invalidate, { product_id: h.target.product_id, scope: 'unknown', region: api.regions[0] });
  for (const scope of api.scopes) {
    await c.post(api.invalidate, { product_id: h.target.product_id, scope, region: api.regions[0] });
    const responses = [];
    for (const region of api.regions)
      responses.push(
        await c.call<Record<string, unknown>>(
          'GET',
          `${stalePath}?${api.consistency_query}=${update.body.revision}`,
          undefined,
          { [api.region_header]: region },
        ),
      );
    if (responses.every((response) => response.status === 200)) {
      c.finish(
        { ...responses[0]!.body, stale_path: stalePath, scope },
        '源站价格更新后，大部分兼容路径实时返回新版本，但一个后缀仍保留区域缓存。局部失效只改变部分副本，客户端版本检查仍失败；所选失效范围之后，每个区域都返回同一修订和价格，证明一致性修复已经覆盖全部副本。',
      );
      return;
    }
  }
  throw new Error('所有区域尚未达到同一版本');
}

export async function solveAlias(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { alias_id: string; revision: number } }>();
  const api = await c.get<{ renders: string; profiles: string[] }>('/api');
  let resource = h.target.alias_id;
  for (let i = 0; i < 8; i++) {
    const alias = await c.call<{ next_resource: string }>('GET', `/api/aliases/${resource}`);
    if (alias.status === 404) break;
    resource = alias.body.next_resource;
  }
  await c.get(`/api/resources/${resource}`);
  await c.call('POST', api.renders, { resource_id: 'missing-resource', format: 'text', profile: api.profiles[0] });
  const render = async (profile: string, format: string) => {
    const job = await c.post<{ status_path: string }>(api.renders, {
      resource_id: h.target.alias_id,
      revision: h.target.revision,
      profile,
      format,
    });
    const ready = await c.poll<{ result_path?: string }>(job.status_path);
    return ready.result_path ? c.get<Record<string, unknown>>(ready.result_path) : undefined;
  };
  await render(api.profiles[0]!, 'thumbnail');
  let answer: Record<string, unknown> | undefined;
  for (const profile of api.profiles) {
    const result = await render(profile, 'text');
    if (result?.revision === h.target.revision) answer = result;
  }
  if (!answer) throw new Error('没有取得指定修订版的素材文本');
  c.finish(
    answer,
    '逐层查询别名得到实际素材，普通素材清单可读，不存在的编号会失败。缩略图只显示版次；文本渲染才给出完整结果。比较全部档位可见，部分档位选了最新版本，所选档位保留指定修订，最终素材号、版次与摘要可以一起复核。',
  );
}

export async function solvePublish(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { page_id: string; revision: number } }>();
  const api = await c.get<{ versions: string; live: string; publish: string; profiles: string[] }>('/api');
  const versions = await c.get<{ current_revision: number }>(api.versions);
  const publish = async (revision: number, profile: string) => {
    const job = await c.post<{ status_path: string; result_path: string }>(api.publish, { revision, profile });
    await c.call('GET', job.result_path);
    await c.poll(job.status_path);
    const result = await c.get<Record<string, unknown>>(job.result_path);
    await c.get(api.live);
    return result;
  };
  await publish(versions.current_revision, api.profiles[0]!);
  await c.call('POST', api.publish, { revision: 0, profile: api.profiles[0] });
  for (const profile of api.profiles) {
    const result = await publish(h.target.revision, profile);
    if (result.revision === h.target.revision && result.asset_revision === h.target.revision) {
      c.finish(
        result,
        '最新版本按普通发布流程完成；非法版次和未完成作业取结果都失败。历史版正文恢复后，某些档位仍保留新版本资源，live 显示混合版次；所选档位完成后正文和资源都回到目标版次，实际发布摘要也与该版一致。',
      );
      return;
    }
  }
  throw new Error('正文与资源没有恢复到同一历史版本');
}
