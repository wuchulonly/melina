// 部署校验器的 HTTP 接口：机器列表、服务列表、校验。文档写了的规则违反了一律说清；藏起来的规则按难度回话。

import { json, noRoute, type SimHandler, segments } from '../kit/http.ts';
import { type ConstraintWorld, type Violation, validate } from './world.ts';

const CODES: Record<Violation['rule'], string> = {
  mem: 'E_MEM',
  port: 'E_PORT',
  affinity: 'E_AFFINITY',
  zone: 'E_ZONE',
};

export function constraintsHandler(world: ConstraintWorld): SimHandler {
  return {
    handle(req) {
      const parts = segments(req.path);
      if (parts.length === 0) return json(200, { service: '部署校验器', docs: '接口和清单格式见附件 deploy.md' });
      if (parts.length !== 1) return noRoute();
      if (parts[0] === 'machines' && req.method === 'GET') {
        return json(
          200,
          world.machines.map((m) => ({ id: m.id, zone: m.zone, cpu: m.cpu, mem: m.mem })),
        );
      }
      if (parts[0] === 'services' && req.method === 'GET') {
        return json(
          200,
          world.services.map((s) => ({ name: s.name, cpu: s.cpu, mem: s.mem, replicas: s.replicas, port: s.port })),
        );
      }
      if (parts[0] !== 'validate') return noRoute();
      if (req.method !== 'POST') return json(405, { error: '校验用 POST，请求体是清单' });
      if (req.body === undefined) return json(400, { ok: false, error: '请求体要是 JSON 格式的清单' });
      const body = req.body as { partial?: unknown };
      const partial = body?.partial === true || req.query.get('partial') === 'true';
      const result = validate(world, req.body, partial);
      if (result.ok) {
        return json(200, partial ? { ok: true, partial: true } : { ok: true, machines_used: result.machinesUsed });
      }
      if (result.documented.length > 0) return json(200, { ok: false, errors: result.documented });
      switch (world.params.feedback) {
        case 'precise':
          return json(200, { ok: false, errors: result.hidden.map((v) => v.message) });
        case 'first': {
          const v = result.hidden[0] as Violation;
          const out: Record<string, unknown> = { ok: false, error: CODES[v.rule] };
          if (v.machine) out.machine = v.machine;
          if (v.service) out.service = v.service;
          if (v.replica !== undefined) out.replica = v.replica;
          return json(200, out);
        }
        case 'opaque':
          return json(200, { ok: false, error: 'rejected' });
      }
    },
  };
}
