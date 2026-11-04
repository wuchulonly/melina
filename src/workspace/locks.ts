// 进程内的锁（v1 单进程）。同一个 workspace 的操作串行；store 的清理（git prune）要独占，
// 别的操作共享：prune 会删掉还没挂上 ref 的新对象，不能和正在打的 snapshot 同时跑。

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

export class KeyedMutex {
  private readonly locks = new Map<string, { mutex: Mutex; users: number }>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let slot = this.locks.get(key);
    if (!slot) {
      slot = { mutex: new Mutex(), users: 0 };
      this.locks.set(key, slot);
    }
    slot.users++;
    try {
      return await slot.mutex.run(fn);
    } finally {
      slot.users--;
      if (slot.users === 0) this.locks.delete(key);
    }
  }
}

/** 读写锁：shared 可以同时有多个，exclusive 等它们都放了才进，进了以后新的 shared 排在它后面 */
export class RwLock {
  private readers = 0;
  private writer = false;
  private readonly queue: { exclusive: boolean; wake: () => void }[] = [];

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire(false);
    try {
      return await fn();
    } finally {
      this.readers--;
      this.drain();
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire(true);
    try {
      return await fn();
    } finally {
      this.writer = false;
      this.drain();
    }
  }

  private acquire(exclusive: boolean): Promise<void> {
    return new Promise((wake) => {
      this.queue.push({ exclusive, wake });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.writer) {
      const next = this.queue[0];
      if (!next) return;
      if (next.exclusive) {
        if (this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        next.wake();
        return;
      }
      this.queue.shift();
      this.readers++;
      next.wake();
    }
  }
}
