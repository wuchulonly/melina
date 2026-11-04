// 收集容器里一次命令的输出（tools/container.ts 用）。
//
// - 只留开头一段和结尾一段，中间省略，内存有上限：命令疯狂刷屏时不会把 Melina 撑爆，也不往磁盘写。
// - 找包装脚本在命令结束后打的结束标记「\nMELINA-EXIT-<随机串> <退出码>\n」：命令自己留下的后台子进程可能一直占着输出管道，
//   引擎的 exec 客户端因此迟迟不退出；看到标记就知道命令已经结束，标记之后的内容（留下的子进程后来写的）丢掉。
// - 标记里退出码后面可以跟三个 cgroup 计数的增量，换成撞到的资源上限。

import type { ExecContention } from '../core/types.ts';

/** 命令前后 cgroup 计数的增量；读不到的没有 */
export interface CgroupDeltas {
  /** pids.events 的 max：进程数撞到上限、起进程失败的次数 */
  pidsMax?: number;
  /** memory.events 的 oom_kill：因为内存超限被杀的进程数 */
  oomKills?: number;
  /** cpu.pressure 里 some 的 total：有进程在等 CPU 的微秒数 */
  cpuUs?: number;
}

/**
 * 计数的增量换成 ContainerExecResult.contention：等 CPU 的微秒数按命令用时折成比例（引擎起 exec 的时间也算在用时里，
 * 比例略偏小）。三项都没读到就没有
 */
export function contentionOf(
  d: CgroupDeltas | undefined,
  durationMs: number,
  scope: ExecContention['scope'],
): ExecContention | undefined {
  if (!d) return undefined;
  const out: ExecContention = { scope };
  if (d.pidsMax !== undefined) out.pidsMax = d.pidsMax;
  if (d.oomKills !== undefined) out.oomKills = d.oomKills;
  if (d.cpuUs !== undefined && durationMs > 0) out.cpuWait = Math.min(1, d.cpuUs / (durationMs * 1000));
  return Object.keys(out).length > 1 ? out : undefined;
}

export interface CollectedOutput {
  head: string;
  tail: string;
  /** 中间省略了多少字节 */
  omitted: number;
  /** 命令一共输出了多少字节（到结束标记为止） */
  total: number;
}

export interface OutputCollectorOptions {
  /** 开头留多少字节 */
  headBytes: number;
  /** 结尾留多少字节 */
  tailBytes: number;
  /** 结束标记里退出码前面的那一段，例如 "\nMELINA-EXIT-3f2a… "；不给就不找 */
  sentinel?: string;
}

export class OutputCollector {
  readonly #headBytes: number;
  readonly #tailBytes: number;
  readonly #sentinel: Buffer | undefined;
  #head: Buffer[] = [];
  #headLen = 0;
  #tail: Buffer[] = [];
  #tailLen = 0;
  #total = 0;
  // 末尾这几个字节可能是结束标记的前半截，等下一块到了再决定
  #holdback: Buffer = Buffer.alloc(0);
  // 找到标记以后，退出码那一行可能还没到齐
  #trailer: Buffer | undefined;
  #exitCode: number | undefined;
  #counters: CgroupDeltas | undefined;
  #done = false;

  constructor(options: OutputCollectorOptions) {
    this.#headBytes = options.headBytes;
    this.#tailBytes = options.tailBytes;
    this.#sentinel = options.sentinel ? Buffer.from(options.sentinel, 'utf8') : undefined;
  }

  /** 找到结束标记、退出码也读全了 */
  get done(): boolean {
    return this.#done;
  }

  /** 结束标记里的退出码；还没找到是 undefined */
  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  /** 结束标记里退出码后面的 cgroup 计数增量；标记里没带（命令没起来、老的包装脚本）是 undefined */
  get counters(): CgroupDeltas | undefined {
    return this.#counters;
  }

  push(chunk: Buffer): void {
    if (this.#done) return;
    if (this.#trailer) {
      this.#trailer = Buffer.concat([this.#trailer, chunk]);
      this.#readExitCode();
      return;
    }
    if (!this.#sentinel) {
      this.#commit(chunk);
      return;
    }
    const data = this.#holdback.length > 0 ? Buffer.concat([this.#holdback, chunk]) : chunk;
    const at = data.indexOf(this.#sentinel);
    if (at >= 0) {
      this.#commit(data.subarray(0, at));
      this.#holdback = Buffer.alloc(0);
      this.#trailer = Buffer.from(data.subarray(at + this.#sentinel.length));
      this.#readExitCode();
      return;
    }
    const keep = Math.min(data.length, this.#sentinel.length - 1);
    this.#commit(data.subarray(0, data.length - keep));
    this.#holdback = Buffer.from(data.subarray(data.length - keep));
  }

  /** 输出流结束了：留着的半截标记原来不是标记，照常算进输出；标记后面的退出码没等到换行也照读 */
  end(): void {
    if (this.#done) return;
    if (this.#trailer) {
      this.#trailer = Buffer.concat([this.#trailer, Buffer.from('\n')]);
      this.#readExitCode();
      return;
    }
    this.#commit(this.#holdback);
    this.#holdback = Buffer.alloc(0);
  }

  result(): CollectedOutput {
    const head = Buffer.concat(this.#head);
    const tail = Buffer.concat(this.#tail);
    const omitted = this.#total - head.length - tail.length;
    if (omitted === 0) {
      // 没省略：两段本来就是连着的，合起来解码，免得把一个字符从中间切开
      return { head: Buffer.concat([head, tail]).toString('utf8'), tail: '', omitted: 0, total: this.#total };
    }
    return {
      head: dropIncompleteEnd(head).toString('utf8'),
      tail: dropIncompleteStart(tail).toString('utf8'),
      omitted,
      total: this.#total,
    };
  }

  #readExitCode(): void {
    const trailer = this.#trailer;
    if (!trailer) return;
    const nl = trailer.indexOf(0x0a);
    if (nl < 0) return;
    const text = trailer.subarray(0, nl).toString('utf8').trim();
    const m = /^(\d+)(?: (\S+) (\S+) (\S+))?$/.exec(text);
    this.#exitCode = m ? Number(m[1]) : undefined;
    if (m?.[2] !== undefined) {
      const counters: CgroupDeltas = {};
      const pidsMax = count(m[2]);
      const oomKills = count(m[3]);
      const cpuUs = count(m[4]);
      if (pidsMax !== undefined) counters.pidsMax = pidsMax;
      if (oomKills !== undefined) counters.oomKills = oomKills;
      if (cpuUs !== undefined) counters.cpuUs = cpuUs;
      this.#counters = counters;
    }
    this.#trailer = undefined;
    this.#done = true;
  }

  #commit(data: Buffer): void {
    if (data.length === 0) return;
    this.#total += data.length;
    let rest = data;
    if (this.#headLen < this.#headBytes) {
      const take = Math.min(rest.length, this.#headBytes - this.#headLen);
      this.#head.push(Buffer.from(rest.subarray(0, take)));
      this.#headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0 || this.#tailBytes === 0) return;
    if (rest.length >= this.#tailBytes) {
      this.#tail = [Buffer.from(rest.subarray(rest.length - this.#tailBytes))];
      this.#tailLen = this.#tailBytes;
      return;
    }
    this.#tail.push(Buffer.from(rest));
    this.#tailLen += rest.length;
    while (this.#tailLen > this.#tailBytes) {
      const first = this.#tail[0];
      if (!first) break;
      const over = this.#tailLen - this.#tailBytes;
      if (first.length <= over) {
        this.#tail.shift();
        this.#tailLen -= first.length;
      } else {
        this.#tail[0] = first.subarray(over);
        this.#tailLen -= over;
      }
    }
  }
}

/** 结束标记里的一个计数增量：非负整数；读不到（-）或者对不上（计数被重置时会是负的）都当没读到 */
function count(text: string | undefined): number | undefined {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
}

/** 末尾被切开的 UTF-8 多字节字符去掉 */
function dropIncompleteEnd(buf: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const byte = buf[buf.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue; // 后续字节，接着往前找起始字节
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

/** 开头的 UTF-8 后续字节（前半个字符被切掉了）去掉 */
function dropIncompleteStart(buf: Buffer): Buffer {
  let i = 0;
  while (i < Math.min(3, buf.length) && ((buf[i] ?? 0) & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}
