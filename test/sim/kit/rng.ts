// 仿真环境用的确定性随机数：同一个种子在哪台机器上都生成同一个世界。
// 用 sfc32，状态取种子 sha256 的前 16 字节。fork(label) 分出互不影响的子序列：
// 世界的一部分改了生成方式，别的部分抽到的数不跟着挪。

import { createHash } from 'node:crypto';

export class Rng {
  readonly seed: string;
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    this.seed = seed;
    const h = createHash('sha256').update(seed).digest();
    this.#a = h.readUInt32LE(0);
    this.#b = h.readUInt32LE(4);
    this.#c = h.readUInt32LE(8);
    this.#d = h.readUInt32LE(12);
    for (let i = 0; i < 12; i++) this.#next();
  }

  /** [0, 1) 的浮点数 */
  float(): number {
    return this.#next() / 4294967296;
  }

  /** [lo, hi] 里的整数，两头都含 */
  int(lo: number, hi: number): number {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) throw new Error(`区间不对：[${lo}, ${hi}]`);
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('从空数组里抽');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** 洗过的新数组，原数组不动 */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** 不放回地抽 n 个 */
  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, n);
  }

  /** 按权重抽：weights 和 items 一一对应 */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.float() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i] ?? 0;
      if (r < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /** 子序列：和本序列、和别的 label 的子序列都互不影响 */
  fork(label: string | number): Rng {
    return new Rng(`${this.seed}/${label}`);
  }

  /** n 个十六进制字符，确定的 */
  hex(n: number): string {
    let out = '';
    while (out.length < n) out += this.#next().toString(16).padStart(8, '0');
    return out.slice(0, n);
  }

  #next(): number {
    const t0 = (this.#a + this.#b) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#d = (this.#d + 1) | 0;
    const t = (t0 + this.#d) | 0;
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }
}

/** 评估默认的总种子：跑分脚本和 sweep 都用它派生每次试验的种子，改了就是换了一套世界 */
export const DEFAULT_MASTER_SEED = 'melina-eval-v1';

/** 由几段拼出一个种子：评估时 (总种子, 任务, 第几次) → 这次试验的世界；各个变体同一次用同一个世界，好成对比较 */
export function deriveSeed(...parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
