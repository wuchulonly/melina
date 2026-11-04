// research-telemetry 的真值和标准解出自同一份解码器（decode），「标准解过」证明不了真值对。
// 这里拿两样结果已知的东西校准：照格式另写的解码器（BigInt varint、按整数求和再按指数换算，和 decode 不共用代码）算出的答案要判过；
// 内容已知的文件（负数、多字节 varint、dt=0、中文和空的标注、三种指数）走 encode 再 decode，测量记录要原样回来。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAnswer } from '../../eval/real/kit.ts';
import { checkTelemetry, decode, encode, generate, truthOf } from '../../eval/real/telemetry/task.ts';
import { Rng } from '../../sim/kit/rng.ts';

/** 照 task.ts 文件头说的格式另写的解码器：只要测量记录，数值按「整数 × 10 的指数次方」精确换算 */
function independentAnswer(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 4).toString('ascii') !== 'KTLM') throw new Error('不是 KTLM');
  const version = b[4] as number;
  let pos = 7; // 魔数 4、版本 1、设备号 2
  let t = BigInt(b.readUInt32LE(pos));
  pos += 4;
  let exp = 0;
  if (version === 2) exp = b.readInt8(pos++);
  const uvarint = () => {
    let r = 0n;
    let shift = 0n;
    for (;;) {
      const x = b[pos++] as number;
      r |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) return r;
      shift += 7n;
    }
  };
  const sums = new Map<number, bigint>();
  const times: bigint[] = [];
  for (;;) {
    const tag = b[pos++] as number;
    if (tag === 0) break;
    t += uvarint();
    if (tag >> 4 === 1) {
      const z = uvarint();
      const raw = (z >> 1n) ^ -(z & 1n);
      sums.set(tag & 0x0f, (sums.get(tag & 0x0f) ?? 0n) + raw);
      times.push(t);
    } else {
      // 先读完长度再挪：写成 pos += Number(uvarint()) 会用读长度之前的 pos
      const length = Number(uvarint());
      pos += length;
    }
  }
  const iso = (s: bigint) => `${new Date(Number(s) * 1000).toISOString().slice(0, 19)}Z`;
  const decimal = (raw: bigint) => {
    if (exp === 0) return Number(raw);
    const digits = (raw < 0n ? -raw : raw).toString().padStart(-exp + 1, '0');
    return Number(`${raw < 0n ? '-' : ''}${digits.slice(0, exp)}.${digits.slice(exp)}`);
  };
  return {
    records: times.length,
    first_time: iso(times[0] as bigint),
    last_time: iso(times[times.length - 1] as bigint),
    sums: Object.fromEntries([...sums].map(([ch, s]) => [String(ch), decimal(s)])),
  };
}

describe('research-telemetry 的真值', () => {
  it('照格式另写的解码器算出的答案判过（10 个种子）', () => {
    for (let i = 0; i < 10; i++) {
      const data = generate(`truth-${i}`);
      const answer = Object.fromEntries(Object.entries(data.unknown).map(([name, b]) => [name, independentAnswer(b)]));
      expect(checkTelemetry(answer, truthOf(data))).toMatchObject({ pass: true });
    }
  });

  it('内容已知的文件 encode 再 decode，测量记录原样回来（200 份）', () => {
    const rng = new Rng('telemetry-truth');
    for (let k = 0; k < 200; k++) {
      const version = k % 2 === 0 ? 1 : 2;
      const scale = version === 2 ? -rng.int(1, 3) : 0;
      const base = 1_780_000_000 + rng.int(0, 1_000_000);
      let t = base;
      const records: Parameters<typeof encode>[0]['records'] = [];
      for (let j = rng.int(1, 40); j > 0; j--) {
        t += rng.pick([0, 1, 127, 128, 16_383, 16_384, 2_000_000]);
        const raw = rng.pick([0, -1, 1, -64, 63, -65, 64, -8192, 8191, -1e9, 1e9, rng.int(-1e6, 1e6)]);
        records.push({ kind: 'm', t, channel: rng.int(0, 15), raw });
        if (version === 2 && rng.chance(0.3)) {
          t += rng.int(0, 2);
          records.push({ kind: 'a', t, channel: rng.int(0, 15), text: rng.pick(['更换探头', 'x'.repeat(200), '']) });
        }
      }
      const want = records.flatMap((r) =>
        r.kind === 'm'
          ? [{ t: r.t, channel: r.channel, value: scale === 0 ? r.raw : Number((r.raw * 10 ** scale).toFixed(-scale)) }]
          : [],
      );
      const bytes = encode({ version, device: rng.int(0, 65_535), base, scale, records });
      expect(decode(bytes).measurements).toEqual(want);
    }
  });

  it('answer.json 开头带 UTF-8 BOM 的照收', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melina-answer-bom-'));
    try {
      writeFileSync(join(dir, 'answer.json'), `${String.fromCharCode(0xfeff)}{"a":1}`);
      expect(readAnswer(dir)).toEqual({ value: { a: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
