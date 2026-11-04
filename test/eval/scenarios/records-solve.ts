// 标准解只使用交接材料与 HTTP 观测，不读取生成器、隐藏规则或判题真值。
import type { SolveContext } from '../../sim/task.ts';
import { Investigator } from './client.ts';

export async function solveSnapshot(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { report_id: string; correction_batch: string } }>();
  const api = await c.get<{
    report: string;
    corrections: string;
    test_change: string;
    exports: string;
    profiles: string[];
  }>('/api');
  await c.get(api.report);
  const corrected = await c.post<{ revision: number; amount_cents: number }>(api.corrections, {
    batch_id: h.target.correction_batch,
  });
  const jobs = [];
  for (const profile of api.profiles)
    jobs.push(
      await c.post<{ status_path: string; result_path: string }>(api.exports, {
        report_id: h.target.report_id,
        profile,
      }),
    );
  await c.call('GET', jobs[0]!.result_path);
  await c.post(api.test_change, {});
  await c.get(api.report);
  let answer: Record<string, unknown> | undefined;
  for (const job of jobs) {
    await c.poll(job.status_path);
    const result = await c.get<{ revision: number; amount_cents: number } & Record<string, unknown>>(job.result_path);
    if (result.revision === corrected.revision && result.amount_cents === corrected.amount_cents) answer = result;
  }
  if (!answer) throw new Error('没有观察到固定修正版本的导出档位');
  c.finish(
    answer,
    '普通读取先确认原始版本，应用修正后同时入队多个档位；未完成作业不能下载。下一批数据到达后，实时读取和部分导出已变成新版本，只有所选档位仍保持入队时的修正版本及金额，因此它适合交付固定结账快照。',
  );
}

export async function solveBatch(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { order_id: string } }>();
  const api = await c.get<{
    order: string;
    query: string;
    profiles: string[];
    links: { order_to_shipment: string; shipment_to_label: string };
  }>('/api');
  await c.get(api.order);
  const operations = [
    { op: 'order', id: h.target.order_id, as: 'order' },
    { op: 'shipment', ref: { from: 'order', field: api.links.order_to_shipment }, as: 'shipment' },
    { op: 'label', ref: { from: 'shipment', field: api.links.shipment_to_label }, as: 'label' },
  ];
  let answer: Record<string, unknown> | undefined;
  // 观察全部档位，不能因为第一个成功就省略不支持引用的对照。
  for (const profile of api.profiles) {
    await c.call('POST', api.query, { profile, operations: [...operations].reverse() });
    const response = await c.call<{ data: { shipment: Record<string, unknown>; label: Record<string, unknown> } }>(
      'POST',
      api.query,
      { profile, operations },
    );
    if (response.status === 200)
      answer = { order_id: h.target.order_id, profile, ...response.body.data.shipment, ...response.body.data.label };
  }
  if (!answer) throw new Error('没有找到可以按依赖顺序解析引用的档位');
  c.finish(
    answer,
    '单项订单读取正常。把标签放在运单之前会找不到依赖；按订单、运单、标签排序仍只有一个档位能完成，其余档位不能解析前序结果的引用。成功批次返回的运单号、标签号和追踪号构成了完整关联链。',
  );
}

export async function solveResume(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ target: { case_id: string; requested_quantity: number }; control: { case_id: string } }>();
  const api = await c.get<{ profiles: string[] }>('/api');
  const checkpoints = async (id: string) =>
    c.get<{ checkpoints: { checkpoint_id: string }[] }>(`/api/cases/${id}/checkpoints`);
  const control = (await checkpoints(h.control.case_id)).checkpoints[0]!;
  const ordinary = await c.post<{ status_path: string }>(`/api/cases/${h.control.case_id}/resume`, {
    checkpoint_id: control.checkpoint_id,
    profile: api.profiles[0],
  });
  await c.poll(ordinary.status_path);
  const old = (await checkpoints(h.target.case_id)).checkpoints[0]!;
  await c.post(`/api/cases/${h.target.case_id}/input`, { quantity: h.target.requested_quantity });
  await c.call('POST', `/api/cases/${h.target.case_id}/resume`, {
    checkpoint_id: old.checkpoint_id,
    profile: api.profiles[0],
  });
  const fresh = await c.post<{ checkpoint_id: string }>(`/api/cases/${h.target.case_id}/checkpoints`, {});
  // 预检不会推进工单，可以独立比较全部档位。
  let selected: string | undefined;
  for (const profile of api.profiles) {
    const response = await c.call('POST', `/api/cases/${h.target.case_id}/resume`, {
      checkpoint_id: fresh.checkpoint_id,
      profile,
      dry_run: true,
    });
    if (response.status === 200) selected = profile;
  }
  if (!selected) throw new Error('恢复上下文没有完成');
  const successful = await c.post<{ status_path: string }>(`/api/cases/${h.target.case_id}/resume`, {
    checkpoint_id: fresh.checkpoint_id,
    profile: selected,
  });
  const completed = await c.poll<{ job_id: string; result: Record<string, unknown> }>(successful.status_path);
  await c.call('POST', `/api/cases/${h.target.case_id}/resume`, {
    checkpoint_id: fresh.checkpoint_id,
    profile: api.profiles[0],
  });
  c.finish(
    { ...completed.result, job_id: completed.job_id },
    '未修改输入的工单可以直接恢复；目标工单更新输入后，旧检查点被拒绝。新检查点配合能够恢复上下文的档位才完成更新后的数量；完成后再次恢复被拒绝，说明恢复点、输入版本和工单状态需要一起核对。',
  );
}
