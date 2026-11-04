// 无工具终局选择一路跑到模型（fauxProvider 按脚本出输出）：真的 ContextAssembler（真的提示词）和 melinaStream；
// RunStore 上两条路线各存个阶段版，生成的版本编号映射回候选。
import { afterEach, describe, expect, it } from 'vitest';
import { createSelectVersion } from '../../../src/agents/select-version.ts';
import type { PickRequest } from '../../../src/core/interfaces/context.ts';
import type { Candidate, Run } from '../../../src/core/types.ts';
import { createTextGenerator } from '../../../src/models/text.ts';
import { A1 } from '../models/fakes.ts';
import { openExplorer, sh } from '../tools/gateway-kit.ts';
import { liveBranch, type RoleKit, roleKit, runOf, say, userText } from './roles-kit.ts';

const kits: RoleKit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});
async function scene() {
  const rk = roleKit();
  kits.push(rk);
  const versions: Candidate[] = [];
  for (const [label, claim] of [
    ['缓存优先', '开大缓存，测了三次都在目标以内'],
    ['并行优先', '加了并行，说两条都证明了'],
  ] as const) {
    const b = await liveBranch(rk, { label });
    await sh(openExplorer(rk.k, b), `echo ${label} 跑完`);
    const snap = `snap-${label}`;
    versions.push(
      rk.k.runStore.writer.deliverVersion({
        branchId: b.branch.id,
        episode: b.branch.episode,
        snapshot: { id: snap },
        candidate: {
          runId: rk.k.run.id,
          branchId: b.branch.id,
          snapshot: snap,
          claim: `${label}：${claim}`,
          interim: true,
        },
      }).candidate,
    );
  }
  const request: PickRequest = {
    versions: versions.map((c, i) => ({
      candidateId: c.id,
      patch: `diff --git a/run.sh b/run.sh\n+第 ${i + 1} 版的改动\n`,
    })),
  };
  const generate = createTextGenerator({ stream: rk.m.stream, registry: rk.m.registry });
  const select = createSelectVersion({ generate, assembler: rk.assembler });
  return { rk, versions, request, select, run: runOf(rk) as Run };
}
describe('无工具的终局选择', () => {
  it('一次生成，选择映射回候选；按挑版调用记账，使用隔离上下文', async () => {
    const { rk, versions, request, select, run } = await scene();
    rk.m.a.setResponses([
      (ctx) => {
        const sys = ctx.messages.find((m) => m.role === 'system');
        expect(sys?.role === 'system' ? (sys.toolsAdded ?? []) : []).toEqual([]);
        const text = userText(ctx.messages);
        expect(text).toContain('缓存优先');
        expect(text).toContain('并行优先');
        expect(text).toContain('diff --git');
        expect(text).not.toContain('# 最近的决定');
        return say(JSON.stringify({ choice: 2, why: '  并行优先的实测更完整  ' }));
      },
    ]);
    const seq = rk.k.runStore.queries.lastSeq();
    expect(await select({ run, request, model: A1, signal: new AbortController().signal })).toEqual({
      candidateId: versions[1]?.id,
      why: '并行优先的实测更完整',
      basedOnSeq: seq,
    });
    expect(rk.m.ledger.entries.map((e) => e.role)).toEqual(['explorer']);
    expect(rk.k.runStore.queries.lastSeq()).toBe(seq);
  });
  it.each([
    '```json\n{"choice":2,"why":"  证据更完整  "}\n```',
    '我选第二版。\n{"choice":2,"why":"  证据更完整  "}\n以上是选择理由。',
    '选择如下（排除 {a}）：\n```json\n{"choice":2,"why":"  证据更完整  "}\n```\n请采用第二版。',
  ])('容忍 JSON 外的代码块和说明：%s', async (text) => {
    const { rk, versions, request, select, run } = await scene();
    rk.m.a.setResponses([say(text)]);
    const seq = rk.k.runStore.queries.lastSeq();
    expect(await select({ run, request, model: A1, signal: new AbortController().signal })).toEqual({
      candidateId: versions[1]?.id,
      why: '证据更完整',
      basedOnSeq: seq,
    });
    expect(rk.m.a.state.callCount).toBe(1);
  });
  it.each([
    '{"choice":0,"why":"越界"}',
    '{"choice":3,"why":"越界"}',
    '{"choice":1.5,"why":"小数"}',
    '{"choice":"1","why":"字符串"}',
    '{"choice":1,"why":" "}',
    '不是 JSON',
    '选择如下：{"choice":3,"why":"越界"}。',
    '选择如下：{"choice":"1","why":"字符串"}。',
    '选择如下：{"choice":1,"why":" "}。',
    '选择如下：{"choice":1,"why":}。',
    '{"choice":1,"why":"第一版"}\n{"choice":2,"why":"第二版"}',
  ])('拒绝不合法结果：%s', async (text) => {
    const { rk, request, select, run } = await scene();
    rk.m.a.setResponses([say(text)]);
    await expect(select({ run, request, model: A1, signal: new AbortController().signal })).rejects.toThrow();
    expect(rk.m.a.state.callCount).toBe(1);
  });
  it('取消后返回的合法 JSON 也不采用', async () => {
    const { rk, request, run } = await scene();
    const controller = new AbortController();
    const select = createSelectVersion({
      assembler: rk.assembler,
      generate: async () => {
        controller.abort(new Error('取消'));
        return '{"choice":1,"why":"迟到"}';
      },
    });
    await expect(select({ run, request, model: A1, signal: controller.signal })).rejects.toThrow('取消');
  });
});
