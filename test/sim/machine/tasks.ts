// 灌装机控制器的三档任务：简单（门槛 1）、中等（门槛 2：直接的做法会踩坑，适合升级和 fork）、
// 难（门槛 3：几种规则要分别摸清，一条分支摸到的事实别的分支用得上）。

import type { CompletionSpec } from '../../../src/core/types.ts';
import type { SimClock } from '../kit/clock.ts';
import {
  type CheckResult,
  type Difficulty,
  type Gate,
  parseJson,
  readDeliverable,
  type SimTask,
  type SimWorld,
} from '../task.ts';
import { BOOT_LANES, machineHandler } from './api.ts';
import { naiveMachine } from './naive.ts';
import { solveMachine } from './solve.ts';
import { describeRules, generateMachine, type MachineParams, type MachineWorld, pad3, press, START } from './world.ts';

export const MACHINE_PRESETS: Record<Difficulty, MachineParams> = {
  easy: {
    buttons: 3,
    modes: ['STANDBY', 'RUN'],
    transitions: [{ entry: false, guard: false }],
    back: false,
    ops: 'add',
    depth: [4, 9],
    trap: false,
    bootMs: 0,
    maxPresses: 300,
  },
  medium: {
    buttons: 5,
    modes: ['STANDBY', 'PRIME', 'RUN'],
    transitions: [
      { entry: true, guard: true },
      { entry: false, guard: false },
    ],
    back: true,
    ops: 'mixed',
    depth: [7, 14],
    trap: true,
    bootMs: 200,
    maxPresses: 300,
  },
  hard: {
    buttons: 6,
    modes: ['STANDBY', 'PRIME', 'HEAT', 'RUN'],
    transitions: [
      { entry: true, guard: false },
      { entry: false, guard: true },
      { entry: true, guard: true },
    ],
    back: true,
    ops: 'mixed',
    pressure: { max: 3, visible: false },
    depth: [12, 24],
    trap: true,
    bootMs: 1000,
    maxPresses: 300,
  },
};

const GATE: Record<Difficulty, Gate> = { easy: 1, medium: 2, hard: 3 };
const LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '难' };

export function machineTask(difficulty: Difficulty, params: MachineParams = MACHINE_PRESETS[difficulty]): SimTask {
  return {
    id: `machine-${difficulty}`,
    env: 'machine',
    difficulty,
    gate: GATE[difficulty],
    title: `灌装机控制器（${LABEL[difficulty]}）`,
    domain: 'general',
    create: (seed) => machineWorld(generateMachine(params, seed), seed),
    solve: solveMachine,
    naive: naiveMachine,
  };
}

export function machineTasks(): SimTask[] {
  return (['easy', 'medium', 'hard'] as const).map((d) => machineTask(d));
}

function machineWorld(world: MachineWorld, seed: string): SimWorld {
  const target = pad3(world.target);
  return {
    seed,
    statement: (url) =>
      `让 ${url} 上的 FC-3 灌装机控制器从开机进入 RUN 状态、屏幕显示 ${target}，` +
      '把从开机到达成目标的按键顺序写进工作目录里的 procedure.json（按键名组成的 JSON 数组），接口说明见附件 manual.md。',
    completion: (): CompletionSpec => ({
      interpretation: `FC-3 的按键规则没有记录，要靠试摸清；交付的是一串从刚开机就能复现的按键顺序，按完以后控制器在 RUN、屏幕正好是 ${target}`,
      criteria: [
        '工作目录根下有 procedure.json，内容是按键名组成的 JSON 数组，例如 ["A","C"]',
        `新开一个会话，照 procedure.json 的顺序一个个按，中途没有进入 LOCKOUT，按完以后面板的 mode 是 RUN、display 是 ${target}`,
      ],
    }),
    materials: (url) => [{ name: 'manual.md', content: manual(world, url) }],
    starter: () => ({ 'README.md': '# FC-3 灌装机控制器\n\n这次任务的交付物 procedure.json 放在这个目录。\n' }),
    handler: (clock: SimClock) => machineHandler(world, clock),
    deliverables: () => ['procedure.json'],
    check: (dir) => checkMachine(world, dir),
    summary: () => ({
      target: world.target,
      shortest: world.shortest.map((b) => world.buttons[b]),
      depth: world.shortest.length,
      relaxedDepth: world.relaxedDepth,
      rules: describeRules(world),
    }),
  };
}

export function checkMachine(world: MachineWorld, dir: string): CheckResult {
  const file = readDeliverable(dir, 'procedure.json');
  if ('error' in file) return { pass: false, summary: file.error };
  const parsed = parseJson(file.text, 'procedure.json');
  if ('error' in parsed) return { pass: false, summary: parsed.error };
  const value = parsed.value;
  if (!Array.isArray(value) || !value.every((b) => typeof b === 'string')) {
    return { pass: false, summary: 'procedure.json 不是字符串数组' };
  }
  if (value.length > world.params.maxPresses) {
    return {
      pass: false,
      summary: `按键顺序有 ${value.length} 个，超过一个会话最多能按的 ${world.params.maxPresses} 次`,
    };
  }
  let s = START;
  for (const [i, name] of value.entries()) {
    const b = world.buttons.indexOf(String(name).toUpperCase());
    if (b < 0) return { pass: false, summary: `第 ${i + 1} 个键「${name}」不存在` };
    s = press(world, s, b);
    if (s.locked) return { pass: false, summary: `按到第 ${i + 1} 个键时锁死了` };
  }
  const run = world.modes.length - 1;
  if (s.mode !== run || s.x !== world.target) {
    return {
      pass: false,
      summary: `按完停在 ${world.modes[s.mode]}、屏幕 ${pad3(s.x)}，目标是 RUN、${pad3(world.target)}`,
    };
  }
  return {
    pass: true,
    summary: `按 ${value.length} 下到 RUN、屏幕 ${pad3(world.target)}（最短 ${world.shortest.length} 下）`,
  };
}

function manual(world: MachineWorld, url: string): string {
  const boot =
    world.params.bootMs > 0
      ? `开一次机要 ${world.params.bootMs / 1000} 秒左右，最多同时开 ${BOOT_LANES} 台，再多的排队。`
      : '';
  return `# FC-3 灌装机控制器：远程面板

控制器的说明书找不到了，这里只有远程面板的接口。各个键的作用、什么情况下会锁死，都没有记录。

## 面板

- 按键：${world.buttons.join('、')}
- 屏幕：三位数，000 到 999
- 状态（mode）：开机后是 STANDBY，控制器跑起来是 RUN，中间可能还有别的状态；LOCKOUT 表示联锁跳闸、控制器锁死了

## 接口

地址：${url}

- \`GET ${url}/\`：型号和按键列表
- \`POST ${url}/sessions\`：开一次机，返回 \`{"session": "…", "panel": {…}}\`。每个会话是一台独立的控制器，从刚开机的状态开始，会话之间互不影响。${boot}
- \`GET ${url}/sessions/<session>\`：看面板和这个会话按过的键，\`{"panel": {…}, "history": ["A", "C"]}\`
- \`POST ${url}/sessions/<session>/press\`：按键。请求体 \`{"button": "A"}\`；一次按一串用 \`{"buttons": ["A", "B", "C"]}\`，返回每按一下以后的面板 \`steps\` 和最后的 \`panel\`
- \`DELETE ${url}/sessions/<session>\`：关掉一个会话

面板长这样：\`{"mode": "STANDBY", "display": "042", "presses": 3}\`，presses 是这个会话按过几次键。

锁死以后这个会话就不能再按了，开一个新会话重来。一个会话最多按 ${world.params.maxPresses} 次键。

例子：

\`\`\`sh
curl -s -X POST ${url}/sessions
curl -s -X POST ${url}/sessions/<session>/press -H 'content-type: application/json' -d '{"button": "A"}'
\`\`\`
`;
}
