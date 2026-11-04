// 灌装机控制器的直接做法：在开机状态试出各键怎么改屏幕，把屏幕调到目标，再一路按换状态的键到 RUN。
// 默认屏幕换状态时不变、没有联锁和压力，也不回头核对。简单的那台这样就够了；中等和难的会到不了或锁死。

import { httpOk, writeJson } from '../client.ts';
import type { SolveContext } from '../task.ts';
import { targetOf } from './solve.ts';

interface Panel {
  mode: string;
  display: string;
}

export async function naiveMachine(ctx: SolveContext): Promise<void> {
  const target = targetOf(ctx.statement);
  const info = await httpOk<{ buttons: string[]; start_mode: string; goal_mode: string }>(`${ctx.url}/`);
  const tryPath = async (path: string[]): Promise<Panel[]> => {
    const { session } = await httpOk<{ session: string }>(`${ctx.url}/sessions`, { method: 'POST' });
    const res = await httpOk<{ steps: { panel: Panel }[] }>(`${ctx.url}/sessions/${session}/press`, {
      method: 'POST',
      body: { buttons: path },
    });
    return res.steps.map((s) => s.panel);
  };

  // 开机状态里各键连按两下，当成固定的加数；会换状态的记下来
  const adds = new Map<string, number>();
  const advances: string[] = [];
  let mode = info.start_mode;
  let prefix: string[] = [];
  for (let hop = 0; hop < 6 && mode !== info.goal_mode; hop++) {
    let next: string | undefined;
    for (const b of info.buttons) {
      const steps = await tryPath([...prefix, b, b]);
      const first = steps[prefix.length];
      const second = steps[prefix.length + 1];
      if (!first || first.mode === 'LOCKOUT') continue;
      if (first.mode !== mode && first.mode !== info.start_mode && !next) next = b;
      if (hop === 0 && first.mode === mode && second && second.mode === mode) {
        const k = (Number(second.display) - Number(first.display) + 1000) % 1000;
        if (k !== 0) adds.set(b, k);
      }
    }
    if (!next) break;
    advances.push(next);
    prefix = [...prefix, next];
    const steps = await tryPath(prefix);
    mode = (steps[steps.length - 1] as Panel).mode;
  }

  // 用开机状态的加数凑出目标（BFS），再接上换状态的键
  const prev = new Map<number, [number, string]>();
  const queue = [0];
  const seen = new Set([0]);
  for (let head = 0; head < queue.length && !seen.has(target); head++) {
    const x = queue[head] as number;
    for (const [b, k] of adds) {
      const y = (x + k) % 1000;
      if (seen.has(y)) continue;
      seen.add(y);
      prev.set(y, [x, b]);
      queue.push(y);
    }
  }
  const path: string[] = [];
  for (let x = target; prev.has(x); x = (prev.get(x) as [number, string])[0]) {
    path.push((prev.get(x) as [number, string])[1]);
  }
  path.reverse();
  writeJson(ctx.dir, 'procedure.json', [...path, ...advances]);
}
