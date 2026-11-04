// 数据与工单的状态绑定：快照时点、批量依赖、暂停后的输入版本。
import { json, noRoute } from '../../sim/kit/http.ts';
import { Rng } from '../../sim/kit/rng.ts';
import { object, type ScenarioFixture } from './kit.ts';

export function snapshotFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`snapshot/${seed}`);
  const target = { report_id: `R-${rng.hex(8)}`, correction_batch: `B-${rng.hex(8)}` };
  const profiles = ['compat', 'standard', 'archive'];
  const snapshotProfile = rng.pick(profiles);
  const lag = rng.int(2, 4);
  const initial = rng.int(10_000, 30_000);
  const corrected = initial + rng.int(100, 900);
  const next = corrected + rng.int(100, 900);
  const checksums = [0, 1, 2, 3].map(() => `sum-${rng.hex(20)}`);
  const result = (revision: number) => ({
    report_id: target.report_id,
    revision,
    row_count: 5,
    amount_cents: [0, initial, corrected, next][revision]!,
    checksum: checksums[revision]!,
  });
  return {
    handover: { target, baseline: { method: 'GET', path: `/api/reports/${target.report_id}/export` } },
    truth: {
      target,
      expected: result(2),
      snapshotProfile,
      lag,
      mechanism: '导出档位使用不同的读取时点，只有一个在入队时固定版本',
    },
    open() {
      let revision = 1;
      let sequence = 0;
      let normalRead = false;
      let earlyRejected = false;
      let liveRead = false;
      let laterExport = false;
      const stableJobs = new Set<string>();
      const jobs = new Map<string, { profile: string; captured: number; polls: number; output?: number }>();
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              report: `/api/reports/${target.report_id}`,
              corrections: `/api/reports/${target.report_id}/corrections`,
              correction_body: ['batch_id'],
              test_change: `/api/reports/${target.report_id}/test-change`,
              exports: '/api/exports',
              export_body: ['report_id', 'profile'],
              profiles,
              scheduling: '查询作业推进一个周期；test-change 模拟修正后的下一批数据到达',
            });
          if (req.method === 'GET' && req.path === `/api/reports/${target.report_id}`) {
            if (revision === 1) normalRead = true;
            if (revision === 3) liveRead = true;
            return json(200, result(revision));
          }
          if (req.method === 'POST' && req.path === `/api/reports/${target.report_id}/corrections`) {
            if (object(req.body).batch_id !== target.correction_batch)
              return json(400, { error: 'correction_batch_required' });
            if (revision !== 1) return json(409, { error: 'correction_already_applied' });
            revision = 2;
            return json(200, result(revision));
          }
          if (req.method === 'POST' && req.path === `/api/reports/${target.report_id}/test-change`) {
            if (revision !== 2) return json(409, { error: 'correct_report_first' });
            revision = 3;
            return json(200, result(revision));
          }
          if (req.method === 'POST' && req.path === '/api/exports') {
            const body = object(req.body);
            if (body.report_id !== target.report_id || !profiles.includes(String(body.profile)))
              return json(400, { error: 'export_parameters' });
            const id = `E-${++sequence}`;
            jobs.set(id, { profile: String(body.profile), captured: revision, polls: 0 });
            return json(202, {
              job_id: id,
              status_path: `/api/exports/${id}`,
              result_path: `/api/exports/${id}/result`,
            });
          }
          const match = /^\/api\/exports\/([^/]+)(\/result)?$/.exec(req.path);
          if (req.method === 'GET' && match) {
            const id = match[1]!;
            const job = jobs.get(id);
            if (!job) return json(404, { error: 'export_missing' });
            if (match[2]) {
              if (job.output === undefined) {
                earlyRejected = true;
                return json(409, { error: 'export_not_ready' });
              }
              if (job.output === 2 && job.profile === snapshotProfile) stableJobs.add(id);
              if (job.output === 3) laterExport = true;
              return json(200, { job_id: id, profile: job.profile, ...result(job.output) });
            }
            job.polls++;
            if (job.polls < lag) return json(202, { job_id: id, state: 'queued' });
            job.output ??= job.profile === snapshotProfile ? job.captured : revision;
            return json(200, { job_id: id, state: 'ready', result_path: `/api/exports/${id}/result` });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.report_id !== target.report_id ||
            answer.revision !== 2 ||
            answer.row_count !== 5 ||
            answer.amount_cents !== corrected ||
            answer.checksum !== checksums[2] ||
            answer.profile !== snapshotProfile ||
            !stableJobs.has(String(answer.job_id))
          )
            return '没有交付修正后、下一批到达前的固定快照';
          if (!normalRead || !earlyRejected || !liveRead || !laterExport || revision !== 3)
            return '缺少普通读取、未完成下载和不同导出时点的对照';
          return undefined;
        },
      };
    },
  };
}

export function batchFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`batch/${seed}`);
  const target = { order_id: `O-${rng.hex(8)}` };
  const shipment = `P-${rng.hex(8)}`;
  const label = `L-${rng.hex(8)}`;
  const tracking = `track-${rng.hex(16)}`;
  const checksum = `label-${rng.hex(20)}`;
  const orderField = rng.pick(['shipment_id', 'dispatch_id', 'parcel_id']);
  const profiles = ['compact', 'compat', 'linked'];
  const linkedProfile = rng.pick(profiles);
  return {
    handover: { target, baseline: { method: 'GET', path: `/api/orders/${target.order_id}/label` } },
    truth: {
      target,
      shipment,
      label,
      tracking,
      checksum,
      linkedProfile,
      orderField,
      mechanism: '批量引用只有在依赖结果已经产生且档位支持串行解析时成立',
    },
    open() {
      let normalRead = false;
      let reversedRejected = false;
      let incompatibleRejected = false;
      let linkedRead = false;
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              order: `/api/orders/${target.order_id}`,
              query: '/api/query',
              profiles,
              operations: ['order', 'shipment', 'label'],
              reference: { from: '此前操作的 as', field: '此前结果的字段' },
              links: { order_to_shipment: orderField, shipment_to_label: 'label_id' },
              body: { profile: '档位', operations: [{ op: 'order', id: '订单号', as: 'order' }] },
            });
          if (req.method === 'GET' && req.path === `/api/orders/${target.order_id}`) {
            normalRead = true;
            return json(200, { order_id: target.order_id, [orderField]: shipment });
          }
          if (req.method === 'POST' && req.path === '/api/query') {
            const body = object(req.body);
            const ops = body.operations;
            if (!profiles.includes(String(body.profile)) || !Array.isArray(ops) || ops.length < 1 || ops.length > 8)
              return json(400, { error: 'query_parameters' });
            const names = ops.map((v) => object(v).as);
            if (names.some((name) => typeof name !== 'string' || !name) || new Set(names).size !== names.length)
              return json(400, { error: 'unique_aliases_required' });
            const data: Record<string, Record<string, unknown>> = {};
            for (const value of ops) {
              const op = object(value);
              if (op.op === 'order') {
                if (op.id !== target.order_id) return json(404, { error: 'order_missing' });
                data[String(op.as)] = { order_id: target.order_id, [orderField]: shipment };
                continue;
              }
              if (!['shipment', 'label'].includes(String(op.op))) return json(400, { error: 'operation_missing' });
              const ref = object(op.ref);
              const previous = data[String(ref.from)];
              if (!previous) {
                if (body.profile === linkedProfile) reversedRejected = true;
                return json(422, { error: 'reference_not_available', operation: op.as });
              }
              if (body.profile !== linkedProfile) {
                incompatibleRejected = true;
                return json(422, { error: 'reference_not_available_in_profile', operation: op.as });
              }
              if (op.op === 'shipment' && previous[String(ref.field)] === shipment)
                data[String(op.as)] = { shipment_id: shipment, label_id: label };
              else if (op.op === 'label' && previous[String(ref.field)] === label) {
                linkedRead = true;
                data[String(op.as)] = { label_id: label, tracking_code: tracking, checksum };
              } else return json(422, { error: 'reference_value_mismatch' });
            }
            return json(200, { profile: body.profile, data });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.order_id !== target.order_id ||
            answer.shipment_id !== shipment ||
            answer.label_id !== label ||
            answer.tracking_code !== tracking ||
            answer.checksum !== checksum ||
            answer.profile !== linkedProfile ||
            !linkedRead
          )
            return '订单、运单和标签没有通过批量依赖关联';
          if (!normalRead || !reversedRejected || !incompatibleRejected)
            return '缺少单项读取、依赖倒序和不支持引用的档位对照';
          return undefined;
        },
      };
    },
  };
}

export function resumeFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`resume/${seed}`);
  const target = { case_id: `C-${rng.hex(8)}`, requested_quantity: rng.int(20, 40) };
  const control = { case_id: `C-${rng.hex(8)}` };
  const profiles = ['continue', 'refresh', 'reconcile'];
  const resumeProfile = rng.pick(profiles);
  const lag = rng.int(2, 4);
  const receipt = `case-${rng.hex(20)}`;
  return {
    handover: {
      target,
      control,
      baseline: {
        method: 'POST',
        path: `/api/cases/${target.case_id}/resume`,
        body: { checkpoint_id: 'CP-1', profile: profiles[0] },
      },
    },
    truth: {
      target,
      control,
      receipt,
      resumeProfile,
      lag,
      mechanism: '修改输入后，旧检查点失效，新检查点还需要恢复完整上下文的档位',
    },
    open() {
      const cases = new Map([
        [target.case_id, { revision: 1, quantity: 10, state: 'paused' }],
        [control.case_id, { revision: 1, quantity: 1, state: 'paused' }],
      ]);
      const checkpoints = new Map([
        ['CP-1', { case_id: target.case_id, revision: 1 }],
        ['CP-2', { case_id: control.case_id, revision: 1 }],
      ]);
      const jobs = new Map<
        string,
        { case_id: string; revision: number; quantity: number; polls: number; profile: string }
      >();
      let checkpointSequence = 2;
      let sequence = 0;
      let normalFinished = false;
      let staleRejected = false;
      let duplicateRejected = false;
      let contextRejected = false;
      let completedJob = '';
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              case: '/api/cases/:id',
              checkpoints: '/api/cases/:id/checkpoints',
              update_input: { path: '/api/cases/:id/input', body: ['quantity'] },
              resume: { path: '/api/cases/:id/resume', body: ['checkpoint_id', 'profile', 'dry_run（可选）'] },
              profiles,
              scheduling: '查询恢复作业推进一个调度周期',
            });
          const match = /^\/api\/cases\/([^/]+)(?:\/(checkpoints|input|resume))?$/.exec(req.path);
          if (match) {
            const id = match[1]!;
            const state = cases.get(id);
            if (!state) return json(404, { error: 'case_missing' });
            if (req.method === 'GET' && !match[2]) return json(200, { case_id: id, ...state });
            if (req.method === 'GET' && match[2] === 'checkpoints')
              return json(200, {
                checkpoints: [...checkpoints]
                  .filter(([, cp]) => cp.case_id === id)
                  .map(([checkpoint_id, cp]) => ({ checkpoint_id, ...cp })),
              });
            if (req.method === 'POST' && match[2] === 'checkpoints') {
              if (state.state !== 'paused') return json(409, { error: 'case_not_paused' });
              const checkpoint_id = `CP-${++checkpointSequence}`;
              checkpoints.set(checkpoint_id, { case_id: id, revision: state.revision });
              return json(201, { checkpoint_id, case_id: id, revision: state.revision });
            }
            if (req.method === 'POST' && match[2] === 'input') {
              const quantity = object(req.body).quantity;
              if (!Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 100)
                return json(400, { error: 'quantity_required' });
              if (state.state !== 'paused') return json(409, { error: 'case_not_paused' });
              state.quantity = Number(quantity);
              state.revision++;
              return json(200, { case_id: id, ...state });
            }
            if (req.method === 'POST' && match[2] === 'resume') {
              const body = object(req.body);
              const checkpoint = checkpoints.get(String(body.checkpoint_id));
              if (!checkpoint || checkpoint.case_id !== id || !profiles.includes(String(body.profile)))
                return json(400, { error: 'resume_parameters' });
              if (state.state !== 'paused') {
                if (id === target.case_id) duplicateRejected = true;
                return json(409, { error: 'case_already_resumed' });
              }
              if (checkpoint.revision !== state.revision) {
                if (id === target.case_id) staleRejected = true;
                return json(409, { error: 'checkpoint_generation_mismatch', input_revision: state.revision });
              }
              if (state.revision > 1 && body.profile !== resumeProfile) {
                contextRejected = true;
                return json(422, { error: 'resume_context_incomplete' });
              }
              if (body.dry_run === true)
                return json(200, { case_id: id, input_revision: state.revision, can_resume: true });
              const job_id = `W-${++sequence}`;
              jobs.set(job_id, {
                case_id: id,
                revision: state.revision,
                quantity: state.quantity,
                polls: 0,
                profile: String(body.profile),
              });
              state.state = 'running';
              return json(202, { job_id, status_path: `/api/resumptions/${job_id}` });
            }
          }
          const status = /^\/api\/resumptions\/([^/]+)$/.exec(req.path);
          if (req.method === 'GET' && status) {
            const job = jobs.get(status[1]!);
            if (!job) return json(404, { error: 'job_missing' });
            job.polls++;
            if (job.polls < lag) return json(202, { job_id: status[1], state: 'queued' });
            cases.get(job.case_id)!.state = 'completed';
            if (job.case_id === control.case_id) normalFinished = true;
            if (
              job.case_id === target.case_id &&
              job.revision === 2 &&
              job.quantity === target.requested_quantity &&
              job.profile === resumeProfile
            )
              completedJob = status[1]!;
            return json(200, {
              job_id: status[1],
              state: 'completed',
              result: {
                case_id: job.case_id,
                input_revision: job.revision,
                quantity: job.quantity,
                receipt: job.case_id === target.case_id ? receipt : 'control-completed',
              },
            });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.case_id !== target.case_id ||
            answer.input_revision !== 2 ||
            answer.quantity !== target.requested_quantity ||
            answer.receipt !== receipt ||
            !completedJob ||
            answer.job_id !== completedJob
          )
            return '目标工单没有按更新后的输入完成';
          if (!normalFinished || !staleRejected || !duplicateRejected || !contextRejected)
            return '缺少普通恢复、旧检查点、上下文档位和重复恢复对照';
          return undefined;
        },
      };
    },
  };
}
