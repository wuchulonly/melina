// 灌装机控制器的远程面板（HTTP）。接口照 manual.md 写的来：开机拿会话、看面板、按键；规则只在 world.ts 里，
// 这里不透露任何规则（锁死只说锁死了，不说为什么）。

import { randomBytes } from 'node:crypto';
import type { SimClock } from '../kit/clock.ts';
import { json, noRoute, type SimHandler, type SimRequest, type SimResponse, segments } from '../kit/http.ts';
import { type MachineState, type MachineWorld, pad3, press, START } from './world.ts';

const MAX_SESSIONS = 5000;
/** 最多同时开几台机：再多的排队。几条分支各自开机不互相卡，靠穷举会话的做法也快不起来 */
export const BOOT_LANES = 8;

interface Session {
  state: MachineState;
  history: string[];
}

export interface Panel {
  mode: string;
  display: string;
  presses: number;
  lamps?: string;
  note?: string;
}

export function panelOf(world: MachineWorld, s: MachineState, presses: number): Panel {
  if (s.locked) {
    return { mode: 'LOCKOUT', display: '---', presses, note: '联锁跳闸，控制器锁死了；这个会话不能再按，开新会话重来' };
  }
  const panel: Panel = { mode: world.modes[s.mode] as string, display: pad3(s.x), presses };
  const pressure = world.params.pressure;
  if (pressure?.visible) panel.lamps = '●'.repeat(s.p) + '○'.repeat(Math.max(0, pressure.max - s.p));
  return panel;
}

export function machineHandler(world: MachineWorld, clock: SimClock): SimHandler {
  const sessions = new Map<string, Session>(); // 顺序就是最久没用的在前
  const lanes = new Array<number>(BOOT_LANES).fill(0); // 每条开机通道什么时候空出来

  async function boot(): Promise<SimResponse> {
    const now = clock.now();
    const lane = lanes.indexOf(Math.min(...lanes));
    const done = Math.max(now, lanes[lane] as number) + world.params.bootMs;
    lanes[lane] = done;
    if (done > now) await clock.sleep(done - now);
    if (sessions.size >= MAX_SESSIONS) {
      // 太多了就丢最久没用的，不挤掉别的分支正在用的
      const stale = sessions.keys().next().value;
      if (stale !== undefined) sessions.delete(stale);
    }
    const id = randomBytes(6).toString('hex');
    sessions.set(id, { state: START, history: [] });
    return json(201, { session: id, panel: panelOf(world, START, 0) });
  }

  function pressing(session: Session, req: SimRequest): SimResponse {
    const wanted = buttonsOf(req);
    if ('error' in wanted) return json(400, { error: wanted.error, buttons: world.buttons });
    const indices: number[] = [];
    for (const name of wanted.buttons) {
      const b = world.buttons.indexOf(name.toUpperCase());
      if (b < 0) return json(400, { error: `没有这个键：${name}`, buttons: world.buttons });
      indices.push(b);
    }
    if (session.state.locked) {
      return json(409, {
        error: '控制器已经锁死，开新会话重来',
        panel: panelOf(world, session.state, session.history.length),
      });
    }
    const steps: { button: string; panel: Panel }[] = [];
    let stopped: string | undefined;
    for (const b of indices) {
      if (session.history.length >= world.params.maxPresses) {
        stopped = `这个会话按键次数用完了（最多 ${world.params.maxPresses} 次），开新会话`;
        break;
      }
      session.state = press(world, session.state, b);
      session.history.push(world.buttons[b] as string);
      steps.push({ button: world.buttons[b] as string, panel: panelOf(world, session.state, session.history.length) });
      if (session.state.locked) {
        if (steps.length < indices.length) stopped = '锁死了，后面的键没有按';
        break;
      }
    }
    if (steps.length === 0) return json(409, { error: stopped ?? '没有按键' });
    const panel = panelOf(world, session.state, session.history.length);
    if (!wanted.batch) return json(200, { panel });
    return json(200, stopped ? { panel, steps, stopped } : { panel, steps });
  }

  return {
    async handle(req) {
      const parts = segments(req.path);
      if (parts.length === 0) {
        if (req.method !== 'GET') return json(405, { error: '这里只能 GET' });
        return json(200, {
          model: 'FC-3',
          buttons: world.buttons,
          display: '000–999',
          start_mode: world.modes[0],
          goal_mode: world.modes[world.modes.length - 1],
          docs: '接口见附件 manual.md',
        });
      }
      if (parts[0] !== 'sessions') return noRoute();
      if (parts.length === 1) {
        if (req.method === 'POST') return boot();
        return json(405, { error: '开机用 POST /sessions' });
      }
      const id = parts[1] as string;
      const session = sessions.get(id);
      if (!session) return json(404, { error: '没有这个会话，可能已经关掉了；开机用 POST /sessions' });
      sessions.delete(id);
      sessions.set(id, session);
      if (parts.length === 2) {
        if (req.method === 'GET') {
          return json(200, {
            session: parts[1],
            panel: panelOf(world, session.state, session.history.length),
            history: session.history,
          });
        }
        if (req.method === 'DELETE') {
          sessions.delete(parts[1] as string);
          return { status: 204 };
        }
        return json(405, { error: '看面板用 GET，关会话用 DELETE' });
      }
      if (parts.length === 3 && parts[2] === 'press') {
        if (req.method !== 'POST') return json(405, { error: '按键用 POST' });
        return pressing(session, req);
      }
      return noRoute();
    },
  };
}

/** 请求体 {"button":"A"} 或 {"buttons":["A","B"]}；也认查询串 ?button=A、?buttons=A,B */
function buttonsOf(req: SimRequest): { buttons: string[]; batch: boolean } | { error: string } {
  const body = req.body as { button?: unknown; buttons?: unknown } | undefined;
  if (body && typeof body === 'object') {
    if (typeof body.button === 'string') return { buttons: [body.button], batch: false };
    if (Array.isArray(body.buttons) && body.buttons.length > 0 && body.buttons.every((b) => typeof b === 'string')) {
      return { buttons: body.buttons as string[], batch: true };
    }
  }
  const one = req.query.get('button');
  if (one) return { buttons: [one], batch: false };
  const many = req.query.get('buttons');
  if (many) return { buttons: many.split(',').map((b) => b.trim()), batch: true };
  if (req.text.trim() !== '' && req.body === undefined) return { error: '请求体要是 JSON，例如 {"button":"A"}' };
  return { error: '要按哪个键？请求体写 {"button":"A"}，一串写 {"buttons":["A","B"]}' };
}
