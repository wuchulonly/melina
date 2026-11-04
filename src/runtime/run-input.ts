import { InputRequest } from '../core/api.ts';
import { conflict } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { HumanInput } from '../core/types.ts';
import { check } from '../core/validate.ts';
import { isEnded, type RunLifecycle } from './run-lifecycle.ts';
import { HINT_NOT_YET } from './templates.ts';
export class RunInput {
  private readonly lifecycle: RunLifecycle;
  private readonly assertNotClosing: (runId: Id) => void;
  constructor(lifecycle: RunLifecycle, assertNotClosing: (runId: Id) => void) {
    this.lifecycle = lifecycle;
    this.assertNotClosing = assertNotClosing;
  }
  async input(runId: Id, req: InputRequest): Promise<HumanInput> {
    check(InputRequest, req, '输入');
    return this.lifecycle.locks.run(runId, () => {
      const run = this.lifecycle.mustRun(runId);
      if (isEnded(run) || run.mode === 'settling') throw conflict('任务已结束或正在交付');
      this.assertNotClosing(runId);
      if (this.lifecycle.deps.queries.listBranches(runId).length === 0) throw conflict(HINT_NOT_YET);
      return this.lifecycle.deps.writer.recordHumanInput({
        runId,
        text: req.text,
        ...(req.key ? { key: req.key } : {}),
        ...(req.acceptance ? { acceptance: req.acceptance } : {}),
      }).input;
    });
  }
}
