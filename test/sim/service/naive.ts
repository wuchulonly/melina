// 订单服务的直接做法：照 api.md 拿令牌，page 从 1 往后翻到 data 为空，按 amount 算分，统计第三季度。
// 不看响应头和多出来的字段，不探参数，也不跟统计接口对数。简单的那个这样就对了；中等和难的会少算或算不准。

import { http, writeJson } from '../client.ts';
import type { SolveContext } from '../task.ts';
import { centsOf, credentialsOf, summarize } from './solve.ts';

export async function naiveService(ctx: SolveContext): Promise<void> {
  const creds = credentialsOf(ctx.materials['api.md'] ?? '');
  const auth = await http(`${ctx.url}/oauth/token`, {
    method: 'POST',
    body: { client_id: creds.id, client_secret: creds.secret },
  });
  const token = (auth.body as { access_token: string }).access_token;
  const found = new Map<string, { cents: number; createdAt: string }>();
  for (let page = 1; page < 100; page++) {
    const res = await http(`${ctx.url}/v1/orders?page=${page}`, { headers: { authorization: `Bearer ${token}` } });
    const data = (res.body as { data?: { id: string; amount: string | number; created_at: string }[] } | undefined)
      ?.data;
    if (res.status !== 200 || !data || data.length === 0) break;
    for (const o of data) found.set(o.id, { cents: centsOf(o.amount), createdAt: o.created_at });
  }
  writeJson(ctx.dir, 'answer.json', summarize(found));
}
