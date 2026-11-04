// 正常业务状态的参考调查：只使用公开材料和实际响应。
import type { SolveContext } from '../../sim/task.ts';
import { Investigator } from './client.ts';

export async function solveRefund(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { order_id: string }; cases: { case_id: string; amount_cents: number }[] }>();
  const api = await c.get<{ refunds: string; key_header: string; ledger: string; reconcile: string }>('/api');
  await c.get(api.ledger);
  await c.call('POST', api.reconcile, { watermark: 0 });
  const first = { order_id: h.target.order_id, ...h.cases[0]! };
  const second = { order_id: h.target.order_id, ...h.cases[1]! };
  const firstKey = { [api.key_header]: `refund-${h.cases[0]!.case_id}` };
  await c.call('POST', api.refunds, first, firstKey);
  await c.call('POST', api.refunds, second, firstKey);
  const retry = await c.post<{ status_path: string }>(api.refunds, first, firstKey);
  await c.call('POST', api.refunds, first, { [api.key_header]: 'different-operation' });
  await c.call(
    'POST',
    api.refunds,
    { ...first, amount_cents: first.amount_cents + 1 },
    { [api.key_header]: 'wrong-amount' },
  );
  await c.poll(retry.status_path);
  const ordinary = await c.post<{ status_path: string }>(api.refunds, second, {
    [api.key_header]: `refund-${h.cases[1]!.case_id}`,
  });
  const posted = await c.poll<{ watermark: number }>(ordinary.status_path);
  await c.get(api.ledger);
  await c.post(api.reconcile, { watermark: posted.watermark });
  c.finish(
    await c.get(api.ledger),
    '首次确认超时后，同一操作键和工单内容取回了已有作业；给另一工单复用同一键会冲突，换键重复处理原工单也被拒绝。第二张工单正常记账，非批准金额无法处理。两项作业完成并按水位同步账本后，实际账本恰有两笔，金额和余额一致。',
  );
}

interface SettlementEvent {
  kind: string;
  entity_id: string;
  version: number;
  amount_cents: number;
}

export async function solveSettlement(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { batch_id: string }; control: { batch_id: string } }>();
  const api = await c.get<{ preview: string; profiles: string[] }>('/api');
  const control = await c.post<{ preview_id: string }>(api.preview, {
    batch_id: h.control.batch_id,
    revision: 1,
    profile: api.profiles[0],
  });
  await c.post(`/api/settlement-previews/${control.preview_id}/confirm`, {});
  await c.call('POST', api.preview, { batch_id: h.target.batch_id, revision: 1, profile: api.profiles[0] });
  let revision = 1;
  for (let i = 0; i < 8; i++) {
    const batch = await c.get<{ revision: number; state: string }>(`/api/batches/${h.target.batch_id}`);
    if (batch.state === 'ready') {
      revision = batch.revision;
      break;
    }
  }
  await c.call('POST', api.preview, { batch_id: h.target.batch_id, revision: revision - 1, profile: api.profiles[0] });
  const latest = new Map<string, SettlementEvent>();
  let cursor: string | null = '';
  do {
    const page: { items: SettlementEvent[]; next_cursor: string | null } = await c.get(
      `/api/batches/${h.target.batch_id}/events?cursor=${cursor}`,
    );
    for (const event of page.items) {
      const key = `${event.kind}/${event.entity_id}`;
      if (!latest.has(key) || latest.get(key)!.version < event.version) latest.set(key, event);
    }
    cursor = page.next_cursor;
  } while (cursor !== null);
  const sum = (kind: string) =>
    [...latest.values()].filter((event) => event.kind === kind).reduce((total, event) => total + event.amount_cents, 0);
  const expected = sum('charge') - sum('refund') - sum('fee');
  for (const profile of api.profiles) {
    const preview = await c.post<{ preview_id: string; net_cents: number }>(api.preview, {
      batch_id: h.target.batch_id,
      revision,
      profile,
    });
    const confirmed = await c.call<Record<string, unknown>>(
      'POST',
      `/api/settlement-previews/${preview.preview_id}/confirm`,
      {},
    );
    if (confirmed.status === 200 && preview.net_cents === expected) {
      await c.get(`/api/batches/${h.target.batch_id}`);
      c.finish(
        confirmed.body,
        '普通批次可以关账；目标批次尚有迟到事件时无法预览，事件到齐后旧批次版本也被拒绝。分页流包含重复和更正后又到达的旧事件，按业务实体取最高版本得到净额。部分预览仍用旧值，确认时失败；最终预览与完整事件流相符并完成关账。',
      );
      return;
    }
  }
  throw new Error('结算预览没有包含最新事件');
}

export async function solveInventory(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{
    target: { sku: string; requested_units: number; abandoned_reservation: string };
    control: { sku: string };
  }>();
  const api = await c.get<{ orders: string; tick: string; reconcile: string; profiles: string[] }>('/api');
  await c.get(`/api/inventory/${h.target.sku}`);
  await c.post(api.orders, { sku: h.control.sku, units: 1 });
  await c.call('POST', api.orders, { sku: h.target.sku, units: h.target.requested_units });
  const releasePath = `/api/reservations/${h.target.abandoned_reservation}/release`;
  const early = await c.call<{ retry_after_ticks: number }>('POST', releasePath, {});
  const clock = await c.post<{ tick: number }>(api.tick, { ticks: early.body.retry_after_ticks });
  await c.get(`/api/reservations/${h.target.abandoned_reservation}`);
  await c.post(releasePath, {});
  await c.get(`/api/inventory/${h.target.sku}`);
  for (const profile of api.profiles) {
    await c.post(api.reconcile, { sku: h.target.sku, profile, through_tick: clock.tick });
    const order = await c.call<{ order_id: string }>('POST', api.orders, {
      sku: h.target.sku,
      units: h.target.requested_units,
    });
    if (order.status === 201) {
      await c.get(`/api/inventory/${h.target.sku}`);
      c.finish(
        await c.get(`/api/orders/${order.body.order_id}`),
        '普通商品可下单，目标商品开始受未到期预留影响而库存不足。推进测试调度后旧预留可以释放，但可售索引仍停在旧值；刷新到包含释放事件的档位后才能完成目标数量。最终物理库存和可售余量同时核对，有效的两件预留仍然保留。',
      );
      return;
    }
  }
  throw new Error('库存索引没有反映已释放预留');
}
