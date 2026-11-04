// 研究题·遥测文件格式（难）：一个传感器网关导出的二进制文件，格式没有文档；附件给了两份样本和厂家工具导出的 CSV，
// 要解出另外三份文件，报每份的测量记录数、首末时间和各通道的数值之和。每次试验按种子生成一套文件。
//
// 格式（小端）：'KTLM'；版本 u8（1 或 2）；设备号 u16；起始时间 u32（Unix 秒）；版本 2 多一个 i8 的十进制指数（数值要乘 10 的这么多次方）。
// 之后是一串记录，第一个字节高 4 位是类型、低 4 位是通道：类型 1 是测量（时间差 varint，单位秒，第一条相对起始时间；数值是 zigzag varint），
// 类型 2 是标注（只在版本 2 里有；时间差 varint，长度 varint，再是 UTF-8 文字）。0x00 结束，后面跟全文件（不含这 4 字节）的 CRC32。
// 藏着的坑：样本 1 是版本 1，看不出指数和标注；样本 2 的 CSV 只有测量值（厂家工具不导出标注），对不上的地方要自己从字节里看出来；
// 未知文件里有版本 2、指数不同的，标注里有中文；大数和负数要多字节 varint、zigzag 才解得对。

import { crc32 } from 'node:zlib';
import { Rng } from '../../../sim/kit/rng.ts';
import type { CheckResult, SolveContext } from '../../../sim/task.ts';
import type { EvalTask } from '../../task.ts';
import { answerCriteria, readAnswer, realTask, writeAnswer } from '../kit.ts';

interface Measurement {
  t: number; // Unix 秒
  channel: number;
  raw: number; // 整数
}

interface Spec {
  version: 1 | 2;
  device: number;
  base: number;
  scale: number; // 版本 2 的十进制指数
  records: (({ kind: 'm' } & Measurement) | { kind: 'a'; t: number; channel: number; text: string })[];
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);

export function encode(spec: Spec): Uint8Array {
  const bytes: number[] = [0x4b, 0x54, 0x4c, 0x4d, spec.version, spec.device & 0xff, spec.device >> 8];
  bytes.push(spec.base & 0xff, (spec.base >>> 8) & 0xff, (spec.base >>> 16) & 0xff, (spec.base >>> 24) & 0xff);
  if (spec.version === 2) bytes.push(spec.scale & 0xff);
  let prev = spec.base;
  for (const r of spec.records) {
    const dt = r.t - prev;
    prev = r.t;
    if (r.kind === 'm') {
      bytes.push(0x10 | r.channel, ...varint(dt), ...varint(zigzag(r.raw)));
    } else {
      const text = [...Buffer.from(r.text, 'utf8')];
      bytes.push(0x20 | r.channel, ...varint(dt), ...varint(text.length), ...text);
    }
  }
  bytes.push(0x00);
  const crc = crc32(Uint8Array.from(bytes));
  bytes.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff);
  return Uint8Array.from(bytes);
}

/** 照格式解（标准解）：只有测量记录，数值已经乘上 10 的指数次方 */
export function decode(bytes: Uint8Array): {
  version: number;
  measurements: { t: number; channel: number; value: number }[];
} {
  const b = Buffer.from(bytes);
  if (b.toString('latin1', 0, 4) !== 'KTLM') throw new Error('不是 KTLM 文件');
  const version = b[4] as number;
  let at = 11;
  let scale = 0;
  if (version === 2) {
    scale = b.readInt8(at);
    at += 1;
  }
  let t = b.readUInt32LE(7);
  const read = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      const x = b[at++] as number;
      n += (x & 0x7f) * mul;
      if (x < 0x80) return n;
      mul *= 0x80;
    }
  };
  const out: { t: number; channel: number; value: number }[] = [];
  for (;;) {
    const tag = b[at++] as number;
    if (tag === 0) break;
    const kind = tag >> 4;
    const channel = tag & 0x0f;
    t += read();
    if (kind === 1) {
      const z = read();
      const raw = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      out.push({ t, channel, value: scale === 0 ? raw : Number((raw * 10 ** scale).toFixed(Math.max(0, -scale))) });
    } else if (kind === 2) {
      const length = read(); // 先读完长度再挪：`at += read()` 会用读长度之前的 at
      at += length;
    } else {
      throw new Error(`认不出的记录类型 ${kind}`);
    }
  }
  return { version, measurements: out };
}

/** 直接的做法：照样本 1（版本 1）的样子解，不管版本 2 的指数和标注 */
function decodeNaive(bytes: Uint8Array): { t: number; channel: number; value: number }[] {
  const b = Buffer.from(bytes);
  let at = 11;
  let t = b.readUInt32LE(7);
  const read = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      const x = b[at++] as number;
      n += (x & 0x7f) * mul;
      if (x < 0x80 || at >= b.length) return n;
      mul *= 0x80;
    }
  };
  const out: { t: number; channel: number; value: number }[] = [];
  while (at < b.length - 5) {
    const tag = b[at++] as number;
    if (tag === 0) break;
    t += read();
    const z = read();
    out.push({ t, channel: tag & 0x0f, value: z % 2 === 0 ? z / 2 : -(z + 1) / 2 });
  }
  return out;
}

const NOTES_TEXT = [
  '这是我们旧机房里一批传感器网关导出的文件（.bin）。厂家早就不在了，格式没有文档，只知道这些：',
  '',
  '- 文件以 4 个字节的 ASCII 「KTLM」开头。',
  '- 网关固件有过一次大升级（1.x 到 2.x），两种固件导出的文件都有。',
  '- 一份文件是一台网关一段时间里各个通道的读数，按时间先后排；时间精确到秒。',
  '- 2.x 的固件会在数据里夹带运维人员写的标注（比如「更换探头」），厂家的导出工具不导出标注。',
  '- 文件末尾有校验。',
  '',
  'sample1.bin、sample2.bin 用厂家的工具导出过，得到 sample1.csv、sample2.csv（time 是 UTC，channel 是通道号，value 是读数）。',
  'unknown1.bin、unknown2.bin、unknown3.bin 没有导出过，工具也找不到了。',
].join('\n');

function makeSpec(rng: Rng, version: 1 | 2, scale: number, n: number, annotations: string[]): Spec {
  const channels = rng.sample([0, 1, 2, 3, 5, 7, 9, 12], rng.int(2, 4));
  const base = Date.UTC(2026, 8, rng.int(1, 25), rng.int(0, 23)) / 1000;
  const level = Object.fromEntries(channels.map((c) => [c, rng.int(-300, 3000)]));
  const records: Spec['records'] = [];
  let t = base + rng.int(0, 30);
  const notes = [...annotations];
  for (let i = 0; i < n; i++) {
    t += rng.chance(0.03) ? rng.int(200, 20000) : rng.int(1, 9);
    const channel = rng.pick(channels);
    level[channel] = (level[channel] as number) + rng.int(-180, 180);
    records.push({ kind: 'm', t, channel, raw: level[channel] as number });
    if (version === 2 && notes.length > 0 && rng.chance(0.02)) {
      t += rng.int(0, 3);
      records.push({ kind: 'a', t, channel, text: notes.shift() as string });
    }
  }
  for (const text of notes) {
    t += rng.int(1, 5);
    records.push({ kind: 'a', t, channel: rng.pick(channels), text });
  }
  return { version, device: rng.int(1, 65535), base, scale, records };
}

const iso = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 19)}Z`;

function csvOf(bytes: Uint8Array): string {
  const lines = ['time,channel,value'];
  for (const m of decode(bytes).measurements) lines.push(`${iso(m.t)},${m.channel},${m.value}`);
  return `${lines.join('\n')}\n`;
}

export interface TelemetryData {
  files: Record<string, Uint8Array | string>;
  unknown: Record<string, Uint8Array>;
}

export function generate(seed: string): TelemetryData {
  const rng = new Rng(`telemetry/${seed}`);
  const s1 = encode(makeSpec(rng.fork('s1'), 1, 0, rng.int(60, 90), []));
  const s2 = encode(makeSpec(rng.fork('s2'), 2, -2, rng.int(80, 120), ['probe swapped', 'calibrated', 'door open']));
  const unknown = {
    'unknown1.bin': encode(makeSpec(rng.fork('u1'), 1, 0, rng.int(900, 1400), [])),
    'unknown2.bin': encode(
      makeSpec(rng.fork('u2'), 2, -1, rng.int(900, 1400), ['fan replaced', 'restart after outage', 'reading drift?']),
    ),
    'unknown3.bin': encode(
      makeSpec(rng.fork('u3'), 2, -3, rng.int(900, 1400), [
        '更换探头',
        '校准后',
        '机房空调检修，读数偏高',
        'sensor 3 flaky',
        '恢复',
      ]),
    ),
  };
  return {
    files: {
      'notes.md': NOTES_TEXT,
      'sample1.bin': s1,
      'sample1.csv': csvOf(s1),
      'sample2.bin': s2,
      'sample2.csv': csvOf(s2),
      ...unknown,
    },
    unknown,
  };
}

interface FileAnswer {
  records: number;
  first_time: string;
  last_time: string;
  sums: Record<string, number>;
}

function summarize(ms: { t: number; channel: number; value: number }[]): FileAnswer {
  const sums: Record<string, number> = {};
  for (const m of ms) sums[String(m.channel)] = (sums[String(m.channel)] ?? 0) + m.value;
  for (const k of Object.keys(sums)) sums[k] = Number((sums[k] as number).toFixed(6));
  const times = ms.map((m) => m.t);
  return {
    records: ms.length,
    first_time: iso(Math.min(...times)),
    last_time: iso(Math.max(...times)),
    sums,
  };
}

export function truthOf(d: TelemetryData): Record<string, FileAnswer> {
  return Object.fromEntries(
    Object.entries(d.unknown).map(([name, bytes]) => [name, summarize(decode(bytes).measurements)]),
  );
}

export function checkTelemetry(answer: Record<string, unknown>, truth: Record<string, FileAnswer>): CheckResult {
  const wrong: string[] = [];
  for (const [name, want] of Object.entries(truth)) {
    const got = answer[name] as Partial<FileAnswer> | undefined;
    if (!got) {
      wrong.push(`${name} 没有答`);
      continue;
    }
    if (got.records !== want.records) wrong.push(`${name}.records（应为 ${want.records}）`);
    if (got.first_time !== want.first_time) wrong.push(`${name}.first_time（应为 ${want.first_time}）`);
    if (got.last_time !== want.last_time) wrong.push(`${name}.last_time（应为 ${want.last_time}）`);
    const sums = (got.sums ?? {}) as Record<string, unknown>;
    const keys = Object.keys(want.sums).sort();
    const gotKeys = Object.keys(sums).sort();
    const sumsOk =
      JSON.stringify(keys) === JSON.stringify(gotKeys) &&
      keys.every((k) => {
        const g = Number(sums[k]);
        const w = want.sums[k] as number;
        return Number.isFinite(g) && Math.abs(g - w) <= Math.max(1e-6, Math.abs(w) * 1e-9);
      });
    if (!sumsOk) wrong.push(`${name}.sums（应为 ${JSON.stringify(want.sums)}）`);
  }
  if (wrong.length === 0) return { pass: true, summary: '三份文件都解对了' };
  return { pass: false, summary: `不对的：${wrong.join('；')}` };
}

const FIELDS =
  '以文件名为键（"unknown1.bin" 等三份），每份 {"records": 测量记录条数（标注不算）, "first_time": 第一条测量的时间, "last_time": 最后一条测量的时间（都是 UTC，格式同 CSV 的 time）, "sums": {"通道号": 这个通道所有读数之和}}，读数和 CSV 里的一样是换算好的值';

/** 二进制附件（.bin）在 SolveContext 里是 latin1 字符串（一个字节一个字符，见 test/eval/task.ts 的 materialText），这里还原 */
const bytesOf = (text: string | undefined) => Uint8Array.from(Buffer.from(text ?? '', 'latin1'));

export function telemetryTask(): EvalTask {
  let cached: { seed: string; data: TelemetryData } | undefined;
  const data = (seed: string) => {
    if (cached?.seed !== seed) cached = { seed, data: generate(seed) };
    return cached.data;
  };
  return realTask({
    id: 'research-telemetry',
    suite: 'research',
    difficulty: 'hard',
    title: '遥测文件格式（难）',
    domain: 'research',
    statement: () =>
      '旧机房的传感器网关导出了一批 .bin 文件，格式没有文档。附件里有两份样本和厂家工具导出的 CSV，把格式弄清楚，解出 unknown1.bin、unknown2.bin、unknown3.bin，报每份的测量记录数、首末时间和各通道读数之和。',
    completion: () => ({
      interpretation: '从样本反推出文件格式（两种固件版本都要对），解出三份未知文件里的测量记录',
      criteria: [
        ...answerCriteria(FIELDS),
        '用 sample1.bin、sample2.bin 和对应 CSV 逐字段比对，验证推断的格式；把格式说明和比对证据写进 report.md。',
      ],
    }),
    starter: () => ({ 'README.md': '# 遥测文件\n\n附件在 /melina/materials，先看 notes.md。\n' }),
    materials: (seed) => Object.entries(data(seed).files).map(([name, content]) => ({ name, content })),
    deliverables: ['answer.json', 'report.md'],
    check: (dir, _ctx, seed) => {
      const a = readAnswer(dir);
      if ('error' in a) return { pass: false, summary: a.error };
      return checkTelemetry(a.value, truthOf(data(seed)));
    },
    solve: async (ctx: SolveContext) => {
      const answer: Record<string, unknown> = {};
      for (const name of ['unknown1.bin', 'unknown2.bin', 'unknown3.bin']) {
        answer[name] = summarize(decode(bytesOf(ctx.materials[name])).measurements);
      }
      writeAnswer(ctx.dir, answer);
    },
    naive: async (ctx: SolveContext) => {
      const answer: Record<string, unknown> = {};
      for (const name of ['unknown1.bin', 'unknown2.bin', 'unknown3.bin']) {
        try {
          answer[name] = summarize(decodeNaive(bytesOf(ctx.materials[name])));
        } catch {
          // 照版本 1 硬解版本 2 的文件，时间会解成没法写的值：这份就交空的
          answer[name] = { records: 0, first_time: '', last_time: '', sums: {} };
        }
      }
      writeAnswer(ctx.dir, answer);
    },
    summary: (seed) => ({ truth: truthOf(data(seed)) }),
  });
}
