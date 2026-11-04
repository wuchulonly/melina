// 正常业务流程的恢复与对账：退款重试、迟到更正、库存预留释放。
import { json, noRoute } from '../../sim/kit/http.ts';
import { Rng } from '../../sim/kit/rng.ts';
import { equals, object, type ScenarioFixture } from './kit.ts';

export function refundFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`refund-retry/${seed}`);
  const target = { order_id: `O-${rng.hex(8)}` };
  const cases = [0, 1].map(() => ({ case_id: `C-${rng.hex(8)}`, amount_cents: rng.int(500, 1_500) }));
  const totalRefund = cases.reduce((sum, entry) => sum + entry.amount_cents, 0);
  const orderAmount = totalRefund + rng.int(1_000, 2_000);
  const keyHeader = rng.pick(['idempotency-key', 'x-operation-key', 'x-request-key']);
  const lag = rng.int(2, 4);
  const checksum = `ledger-${rng.hex(20)}`;
  return {
    handover: {
      target,
      cases,
      baseline: { method: 'POST', path: '/api/refunds', body: { order_id: target.order_id, ...cases[0] } },
    },
    truth: {
      target,
      cases,
      totalRefund,
      orderAmount,
      keyHeader,
      lag,
      checksum,
      mechanism: '首次确认响应丢失但作业已入队，重试必须保持操作键和工单内容一致，账本另需同步',
    },
    open() {
      let sequence = 0;
      let ackLost = false;
      let retried = false;
      let mismatchRejected = false;
      let duplicateRejected = false;
      let amountRejected = false;
      let reconcileRejected = false;
      let normalRead = false;
      let reconciled = false;
      let finalRead = false;
      const keys = new Map<string, { fingerprint: string; id: string }>();
      const jobs = new Map<string, { case_id: string; amount_cents: number; polls: number; posted: boolean }>();
      const entries = new Map<string, number>();
      const ledger = () => ({
        order_id: target.order_id,
        refund_ids: [...entries.keys()],
        refunded_cents: [...entries.values()].reduce((sum, amount) => sum + amount, 0),
        ledger_entries: entries.size,
        remaining_cents: orderAmount - totalRefund,
        checksum,
      });
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              refunds: '/api/refunds',
              refund_body: ['order_id', 'case_id', 'amount_cents'],
              key_header: keyHeader,
              ledger: `/api/orders/${target.order_id}/ledger`,
              reconcile: `/api/orders/${target.order_id}/reconcile`,
              reconcile_body: ['watermark'],
              scheduling: '查询退款作业推进一个周期；金额须等于工单批准金额，每张工单只处理一次',
            });
          if (req.method === 'GET' && req.path === `/api/orders/${target.order_id}/ledger`) {
            if (jobs.size === 0) normalRead = true;
            if (reconciled) {
              finalRead = true;
              return json(200, { ...ledger(), state: 'reconciled' });
            }
            return json(200, {
              order_id: target.order_id,
              ledger_entries: 0,
              refunded_cents: 0,
              watermark: 0,
              state: 'unsynchronized',
            });
          }
          if (req.method === 'POST' && req.path === '/api/refunds') {
            const body = object(req.body);
            const approved = cases.find((entry) => entry.case_id === body.case_id);
            if (body.order_id !== target.order_id || !approved) return json(404, { error: 'refund_case_missing' });
            if (body.amount_cents !== approved.amount_cents) {
              amountRejected = true;
              return json(422, { error: 'approved_amount_required' });
            }
            const key = req.headers[keyHeader];
            if (!key || key.length > 100) return json(400, { error: 'operation_key_required', header: keyHeader });
            const fingerprint = JSON.stringify({
              order_id: target.order_id,
              case_id: approved.case_id,
              amount_cents: approved.amount_cents,
            });
            const previous = keys.get(key);
            if (previous) {
              if (previous.fingerprint !== fingerprint) {
                mismatchRejected = true;
                return json(409, { error: 'key_payload_mismatch' });
              }
              if (approved.case_id === cases[0]!.case_id) retried = true;
              return json(202, { refund_id: previous.id, status_path: `/api/refunds/${previous.id}`, replayed: true });
            }
            if ([...jobs.values()].some((job) => job.case_id === approved.case_id)) {
              duplicateRejected = true;
              return json(409, { error: 'case_refund_already_scheduled' });
            }
            const id = `F-${++sequence}`;
            keys.set(key, { fingerprint, id });
            jobs.set(id, { case_id: approved.case_id, amount_cents: approved.amount_cents, polls: 0, posted: false });
            if (approved.case_id === cases[0]!.case_id && !ackLost) {
              ackLost = true;
              return json(504, { error: 'acknowledgement_lost', recovery: '同一操作键与同一请求体可重试' });
            }
            return json(202, { refund_id: id, status_path: `/api/refunds/${id}`, replayed: false });
          }
          const status = /^\/api\/refunds\/([^/]+)$/.exec(req.path);
          if (req.method === 'GET' && status) {
            const id = status[1]!;
            const job = jobs.get(id);
            if (!job) return json(404, { error: 'refund_missing' });
            job.polls++;
            if (job.polls < lag) return json(202, { refund_id: id, state: 'processing' });
            if (!job.posted) {
              job.posted = true;
              entries.set(id, job.amount_cents);
            }
            return json(200, {
              refund_id: id,
              case_id: job.case_id,
              amount_cents: job.amount_cents,
              state: 'posted',
              watermark: entries.size,
            });
          }
          if (req.method === 'POST' && req.path === `/api/orders/${target.order_id}/reconcile`) {
            if (entries.size !== cases.length || object(req.body).watermark !== entries.size) {
              reconcileRejected = true;
              return json(409, { error: 'refund_watermark_not_ready', current_watermark: entries.size });
            }
            reconciled = true;
            return json(200, { ...ledger(), state: 'reconciled' });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.order_id !== target.order_id ||
            answer.refunded_cents !== totalRefund ||
            answer.ledger_entries !== 2 ||
            answer.remaining_cents !== orderAmount - totalRefund ||
            answer.checksum !== checksum ||
            !equals(answer.refund_ids, [...entries.keys()]) ||
            entries.size !== 2 ||
            !reconciled ||
            !finalRead
          )
            return '两张批准工单尚未各记一次并完成账本对账';
          if (
            !normalRead ||
            !ackLost ||
            !retried ||
            !mismatchRejected ||
            !duplicateRejected ||
            !amountRejected ||
            !reconcileRejected
          )
            return '缺少确认丢失、同键重试、异工单冲突、重复工单、金额和账本时点对照';
          return undefined;
        },
      };
    },
  };
}

export function settlementFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`settlement-events/${seed}`);
  const target = { batch_id: `B-${rng.hex(8)}` };
  const control = { batch_id: `B-${rng.hex(8)}` };
  const charges = [0, 1, 2].map(() => rng.int(3_000, 6_000));
  const gross = charges.reduce((sum, amount) => sum + amount, 0);
  const oldRefund = rng.int(100, 300);
  const refund = oldRefund + rng.int(100, 300);
  const oldFee = rng.int(100, 300);
  const fee = oldFee + rng.int(50, 200);
  const profiles = ['cached', 'rebuild', 'events', 'compat'];
  const completeProfile = rng.pick(profiles.slice(1));
  const lag = rng.int(2, 4);
  const checksum = `settlement-${rng.hex(20)}`;
  const event = (kind: string, entity: string, version: number, amount: number) => ({
    event_id: `${entity}-v${version}`,
    kind,
    entity_id: entity,
    version,
    amount_cents: amount,
  });
  const initialEvents = rng.shuffle([
    ...charges.map((amount, i) => event('charge', `payment-${i}`, 1, amount)),
    event('refund', 'refund-1', 1, oldRefund),
    event('fee', 'fee-1', 1, oldFee),
    event('charge', 'payment-0', 1, charges[0]!),
  ]);
  const events = [
    ...initialEvents,
    event('fee', 'fee-1', 2, fee),
    event('refund', 'refund-1', 2, refund),
    event('fee', 'fee-1', 1, oldFee),
  ];
  return {
    handover: {
      target,
      control,
      baseline: {
        method: 'POST',
        path: '/api/settlement-previews',
        body: { batch_id: target.batch_id, revision: 1, profile: 'cached' },
      },
    },
    truth: {
      target,
      control,
      gross,
      refund,
      fee,
      net: gross - refund - fee,
      checksum,
      completeProfile,
      lag,
      mechanism: '事件有重复和迟到旧版本，结算必须使用每个业务实体的最新更正并匹配批次版本',
    },
    open() {
      let polls = 0;
      let sequence = 0;
      let normalConfirmed = false;
      let pendingRejected = false;
      let staleRejected = false;
      let wrongRejected = false;
      let eventsRead = false;
      let confirmed = '';
      let finalRead = false;
      const previews = new Map<
        string,
        {
          batch_id: string;
          revision: number;
          gross_cents: number;
          refund_cents: number;
          fee_cents: number;
          net_cents: number;
          checksum: string;
          profile: string;
        }
      >();
      const ready = () => polls >= lag;
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              batch: '/api/batches/:id',
              events: '/api/batches/:id/events?cursor=游标',
              preview: '/api/settlement-previews',
              preview_body: ['batch_id', 'revision', 'profile'],
              profiles,
              confirm: '/api/settlement-previews/:id/confirm',
              event_fields: ['event_id', 'kind', 'entity_id', 'version', 'amount_cents'],
              scheduling: '查询目标批次推进一个周期；事件游标从空开始，返回 next_cursor',
            });
          const batch = /^\/api\/batches\/([^/]+)(\/events)?$/.exec(req.path);
          if (req.method === 'GET' && batch) {
            const id = batch[1]!;
            if (![target.batch_id, control.batch_id].includes(id)) return json(404, { error: 'batch_missing' });
            if (!batch[2]) {
              if (id === target.batch_id) polls++;
              if (id === target.batch_id && confirmed) finalRead = true;
              return json(200, {
                batch_id: id,
                revision: id === control.batch_id ? 1 : ready() ? 2 : 1,
                state:
                  id === control.batch_id || ready()
                    ? confirmed && id === target.batch_id
                      ? 'closed'
                      : 'ready'
                    : 'pending_events',
              });
            }
            const cursor = Number(req.query.get('cursor') ?? 0);
            const available =
              id === control.batch_id ? [event('charge', 'control', 1, 2_000)] : ready() ? events : initialEvents;
            if (!Number.isInteger(cursor) || cursor < 0 || cursor >= available.length)
              return json(400, { error: 'cursor_required' });
            const next_cursor = cursor + 2 < available.length ? String(cursor + 2) : null;
            if (id === target.batch_id && ready() && next_cursor === null) eventsRead = true;
            return json(200, { items: available.slice(cursor, cursor + 2), next_cursor });
          }
          if (req.method === 'POST' && req.path === '/api/settlement-previews') {
            const body = object(req.body);
            const isTarget = body.batch_id === target.batch_id;
            if (!isTarget && body.batch_id !== control.batch_id) return json(404, { error: 'batch_missing' });
            if (!profiles.includes(String(body.profile))) return json(400, { error: 'profile_required' });
            if (isTarget && !ready()) {
              pendingRejected = true;
              return json(409, { error: 'pending_events' });
            }
            const revision = isTarget ? 2 : 1;
            if (body.revision !== revision) {
              if (isTarget) staleRejected = true;
              return json(409, { error: 'batch_revision_mismatch', revision });
            }
            const correct = !isTarget || body.profile === completeProfile;
            const values = {
              gross_cents: isTarget ? gross : 2_000,
              refund_cents: isTarget ? (correct ? refund : oldRefund) : 0,
              fee_cents: isTarget ? (correct ? fee : oldFee) : 0,
            };
            const id = `V-${++sequence}`;
            const preview = {
              batch_id: String(body.batch_id),
              revision,
              ...values,
              net_cents: values.gross_cents - values.refund_cents - values.fee_cents,
              checksum: isTarget && correct ? checksum : `draft-${id}`,
              profile: String(body.profile),
            };
            previews.set(id, preview);
            return json(201, { preview_id: id, ...preview });
          }
          const confirm = /^\/api\/settlement-previews\/([^/]+)\/confirm$/.exec(req.path);
          if (req.method === 'POST' && confirm) {
            const id = confirm[1]!;
            const preview = previews.get(id);
            if (!preview) return json(404, { error: 'preview_missing' });
            if (preview.batch_id === target.batch_id && preview.net_cents !== gross - refund - fee) {
              wrongRejected = true;
              return json(422, { error: 'preview_does_not_include_latest_events' });
            }
            if (preview.batch_id === control.batch_id) normalConfirmed = true;
            else confirmed = id;
            return json(200, { preview_id: id, settlement_id: `S-${id}`, ...preview, state: 'closed' });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.batch_id !== target.batch_id ||
            answer.revision !== 2 ||
            answer.gross_cents !== gross ||
            answer.refund_cents !== refund ||
            answer.fee_cents !== fee ||
            answer.net_cents !== gross - refund - fee ||
            answer.checksum !== checksum ||
            !confirmed ||
            answer.preview_id !== confirmed ||
            answer.settlement_id !== `S-${confirmed}` ||
            !finalRead
          )
            return '结算没有使用目标批次的最新退款和费用更正';
          if (!normalConfirmed || !pendingRejected || !staleRejected || !wrongRejected || !eventsRead)
            return '缺少普通关账、迟到事件、旧批次版本、过期预览和完整事件流对照';
          return undefined;
        },
      };
    },
  };
}

export function inventoryFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`inventory-release/${seed}`);
  const physical = rng.int(8, 14);
  const target = { sku: `SKU-${rng.hex(8)}`, requested_units: physical - 3, abandoned_reservation: `H-${rng.hex(8)}` };
  const activeReservation = `H-${rng.hex(8)}`;
  const control = { sku: `SKU-${rng.hex(8)}` };
  const profiles = ['snapshot', 'events', 'compat'];
  const completeProfile = rng.pick(profiles);
  const ttl = rng.int(2, 4);
  const checksum = `stock-${rng.hex(20)}`;
  return {
    handover: {
      target,
      control,
      baseline: { method: 'POST', path: '/api/orders', body: { sku: target.sku, units: target.requested_units } },
    },
    truth: {
      target,
      control,
      physical,
      activeReservation,
      completeProfile,
      ttl,
      checksum,
      mechanism: '预留过期与可售索引刷新分开，释放旧预留后仍需更新索引并保留有效预留',
    },
    open() {
      let tick = 0;
      let released = false;
      let available = physical - 5;
      let remainingPhysical = physical;
      let normalOrder = false;
      let earlyRejected = false;
      let insufficientRejected = false;
      let staleObserved = false;
      let reconciled = false;
      let finalRead = false;
      let sequence = 0;
      let targetOrder = '';
      const orders = new Map<string, Record<string, unknown>>();
      const actualAvailable = () => remainingPhysical - 2 - (released ? 0 : 3);
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              inventory: '/api/inventory/:sku',
              reservation: '/api/reservations/:id',
              release: '/api/reservations/:id/release',
              tick: '/api/scheduler/tick',
              tick_body: ['ticks'],
              reconcile: '/api/inventory/reconcile',
              reconcile_body: ['sku', 'profile', 'through_tick'],
              profiles,
              orders: '/api/orders',
              order_body: ['sku', 'units'],
              scheduling: '预留寿命只由 scheduler/tick 推进；有效预留保留至本题结束',
            });
          if (req.method === 'GET' && req.path === `/api/inventory/${target.sku}`) {
            if (released && available < actualAvailable()) staleObserved = true;
            return json(200, {
              sku: target.sku,
              physical_units: remainingPhysical,
              available_units: available,
              tick,
              reservations: [
                { reservation_id: activeReservation, units: 2, state: 'active' },
                {
                  reservation_id: target.abandoned_reservation,
                  units: 3,
                  state: released ? 'released' : tick >= ttl ? 'expired' : 'active',
                },
              ],
            });
          }
          if (req.method === 'GET' && req.path === `/api/reservations/${target.abandoned_reservation}`)
            return json(200, {
              reservation_id: target.abandoned_reservation,
              state: released ? 'released' : tick >= ttl ? 'expired' : 'active',
              tick,
            });
          if (req.method === 'POST' && req.path === `/api/reservations/${target.abandoned_reservation}/release`) {
            if (tick < ttl) {
              earlyRejected = true;
              return json(409, { error: 'reservation_not_expired', retry_after_ticks: ttl - tick });
            }
            released = true;
            return json(200, { reservation_id: target.abandoned_reservation, released: true, tick });
          }
          if (req.method === 'POST' && req.path === '/api/scheduler/tick') {
            const amount = object(req.body).ticks;
            if (!Number.isInteger(amount) || Number(amount) < 1 || Number(amount) > 8)
              return json(400, { error: 'ticks_required' });
            tick += Number(amount);
            return json(200, { tick });
          }
          if (req.method === 'POST' && req.path === '/api/inventory/reconcile') {
            const body = object(req.body);
            if (body.sku !== target.sku || !profiles.includes(String(body.profile)) || body.through_tick !== tick)
              return json(400, { error: 'reconcile_parameters' });
            if (!released) return json(409, { error: 'reservation_release_pending' });
            if (body.profile === completeProfile) {
              available = actualAvailable();
              reconciled = true;
            }
            return json(200, {
              sku: target.sku,
              available_units: available,
              through_tick: tick,
              profile: body.profile,
            });
          }
          if (req.method === 'POST' && req.path === '/api/orders') {
            const body = object(req.body);
            if (![target.sku, control.sku].includes(String(body.sku))) return json(404, { error: 'sku_missing' });
            const units = body.units;
            if (!Number.isInteger(units) || Number(units) < 1) return json(400, { error: 'units_required' });
            if (body.sku === target.sku && (Number(units) > available || Number(units) > actualAvailable())) {
              insufficientRejected = true;
              return json(409, { error: 'insufficient_available_units', available_units: available });
            }
            if (body.sku === control.sku && Number(units) !== 1)
              return json(400, { error: 'control_order_requires_one_unit' });
            if (body.sku === target.sku && targetOrder) return json(409, { error: 'target_order_already_placed' });
            const id = `O-${++sequence}`;
            if (body.sku === control.sku) normalOrder = true;
            else {
              targetOrder = id;
              available -= Number(units);
              remainingPhysical -= Number(units);
            }
            const order = {
              order_id: id,
              sku: body.sku,
              units,
              remaining_available: body.sku === target.sku ? available : 4,
              checksum: body.sku === target.sku ? checksum : 'control-stock',
            };
            orders.set(id, order);
            return json(201, order);
          }
          const order = /^\/api\/orders\/([^/]+)$/.exec(req.path);
          if (req.method === 'GET' && order) {
            const result = orders.get(order[1]!);
            if (!result) return json(404, { error: 'order_missing' });
            if (order[1] === targetOrder) finalRead = true;
            return json(200, result);
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.sku !== target.sku ||
            answer.units !== target.requested_units ||
            !targetOrder ||
            answer.order_id !== targetOrder ||
            answer.remaining_available !== 1 ||
            answer.checksum !== checksum ||
            !released ||
            !reconciled ||
            !finalRead ||
            remainingPhysical !== 3 ||
            available !== 1
          )
            return '目标订单没有在释放旧预留、保留有效预留后按数量完成';
          if (!normalOrder || !earlyRejected || !insufficientRejected || !staleObserved)
            return '缺少正常订单、未过期释放、库存不足和延迟索引对照';
          return undefined;
        },
      };
    },
  };
}
