// 运行时组装按当前任务提供动态扩展提示，覆盖真实 SDK 入口。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { melinaRuntime } from '../../../src/api/runtime.ts';
import { type InfraDeps, Melina } from '../../../src/api/sdk.ts';
import { DEFAULT_RUN_CONFIG } from '../../../src/core/config.ts';
import { newId } from '../../../src/core/ids.ts';
import type { ContextAssembler } from '../../../src/core/interfaces/context.ts';
import type { RuntimeKernel } from '../../../src/runtime/runtime.ts';
import { betDraft, MODEL } from '../storage/kit.ts';

describe('默认运行时提供 Bet 0 会话提示', () => {
  it.each([false, true])('Bet 0 与动态扩展提示都保留（追加提示：%s）', async (withExtension) => {
    const dir = mkdtempSync(join(tmpdir(), 'melina-runtime-prompts-'));
    const extra = '测试扩展的 Explorer 补充说明';
    let deps: InfraDeps | undefined;
    let assembler: ContextAssembler | undefined;
    let runtime: RuntimeKernel | undefined;
    let melina: Melina | undefined;
    try {
      melina = new Melina(
        { db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts') },
        {
          containers: null,
          env: {},
          log: { warn() {}, error() {} },
          runtime: melinaRuntime({
            onCreated: (value) => {
              runtime = value;
            },
            extensions: [
              (value) => {
                deps = value;
                return {
                  tools: [],
                  ...(withExtension ? { prompts: { explorer: ({ run }) => `${extra}：${run.goal.statement}` } } : {}),
                  prepare: (services) => {
                    assembler = services.assembler;
                  },
                };
              },
            ],
          }),
        },
      );
      await melina.ready();
      if (!deps || !assembler || !runtime) throw new Error('运行时没有完成组装');
      // 只检查真实组装出来的上下文，停下调度后造记录，不调用模型或启动分支。
      await runtime.runs.stop();
      const run = deps.writer.createRun({
        id: newId(),
        goal: { statement: '整理项目说明', constraints: [], materials: [] },
        workspace: { root: dir, kind: 'dir-copy' },
        config: { ...DEFAULT_RUN_CONFIG, bet0: { models: [MODEL] } },
        createdAt: '2026-10-15T00:00:00.000Z',
      });
      for (let copy = 0; copy < 3; copy++) {
        const bet = deps.writer.createBet({
          ...betDraft({ kind: 'direct' }),
          runId: run.id,
          source: { kind: 'template' },
        });
        const branch = deps.writer.createBranch({ runId: run.id, betId: bet.id, lastSnapshot: 'root' });
        const layout = assembler.forExplorer(branch);
        expect(layout.system).toContain('# 持续求解');
        expect(layout.system).not.toContain('每个 episode 都从干净的上下文开始');
        const close = layout.tools.find((tool) => tool.name === 'end_episode');
        expect(close?.parameters).toHaveProperty('properties.candidate');
        expect(close?.parameters).toHaveProperty('properties.handoff');
        expect(close?.parameters).not.toHaveProperty('properties.exit');
        if (withExtension) {
          expect(layout.system.split(extra)).toHaveLength(2);
          expect(layout.system).toContain(`${extra}：${run.goal.statement}`);
          expect(layout.system.indexOf(extra)).toBeLessThan(layout.system.indexOf('# 目标'));
        } else {
          expect(layout.system).not.toContain(extra);
        }
      }
    } finally {
      await melina?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
