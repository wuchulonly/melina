// 仿真环境的时钟。限流、开机排队这类规则看时间；单元测试里换成虚拟时钟，标准解按 Retry-After 等的时候不真等。

export interface SimClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: SimClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** 虚拟时钟：sleep 不等，直接把时间往后拨。环境和标准解共用同一个，测试跑得快、结果确定 */
export class VirtualClock implements SimClock {
  #t: number;

  constructor(start = Date.UTC(2026, 9, 2)) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  async sleep(ms: number): Promise<void> {
    this.#t += Math.max(0, ms);
  }
}
