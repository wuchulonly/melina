import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ContinuationState } from '../core/continuation.ts';
import { type Id, newId } from '../core/ids.ts';
import { check } from '../core/validate.ts';

/** 文件写完并同步后原子替换；崩溃只会留下旧版或新版，半份计划不会被执行。 */
export class ContinuationStates {
  readonly #root: string;
  readonly #cache = new Map<Id, ContinuationState>();

  constructor(root: string) {
    this.#root = root;
  }

  async load(runId: Id): Promise<ContinuationState> {
    const cached = this.#cache.get(runId);
    if (cached) return structuredClone(cached);
    let state: ContinuationState;
    try {
      const text = await readFile(join(this.#root, runId, 'continuation.json'), 'utf8');
      if (text.length > 1_000_000) throw new Error('摘要调度状态文件过大');
      state = check(ContinuationState, JSON.parse(text), '摘要调度状态');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { version: 1, handled: [], access: [], acceptance: [] };
    }
    this.#cache.set(runId, state);
    return structuredClone(state);
  }

  async save(runId: Id, state: ContinuationState): Promise<void> {
    check(ContinuationState, state, '摘要调度状态');
    const dir = join(this.#root, runId);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `.continuation-${newId()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(dir, 'continuation.json'));
      const directory = await open(dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.#cache.set(runId, structuredClone(state));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  forget(runId: Id): void {
    this.#cache.delete(runId);
  }
}
