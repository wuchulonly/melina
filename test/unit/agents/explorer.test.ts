import { afterEach, expect, it } from 'vitest';
import ctfExtension from '../../../extensions/ctf/entry.ts';
import { COMPACT_KEEP, COMPACT_RATIO } from '../../../src/agents/explorer.ts';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { loadPrompt } from '../../../src/context/prompts.ts';
import { bet, closeInto, episode, type Flow, flow, say, tool, turn, userTexts } from './flow-kit.ts';

let f: Flow;
afterEach(() => f?.k.cleanup());
it('同一直接会话执行工具、收到提示并交候选，收尾时无需引用协议', async () => {
  f = flow();
  const b = await bet(f);
  const ep = await episode(f, b, [
    turn(tool('sh', { cmd: 'printf verified' })),
    turn(tool('end_episode', { candidate: { claim: '验证通过' } })),
  ]);
  expect(ep.outcome.close).toEqual({ kind: 'candidate', claim: '验证通过' });
  expect(ep.outcome.toolCalls).toBe(1);
  expect(ep.requests).toHaveLength(2);
  const closed = closeInto(f, b, ep.outcome);
  expect(closed.candidate?.claim).toBe('验证通过');
  expect(f.k.runStore.queries.getRun(f.k.run.id)?.mode).toBe('settling');
});
it('模型暂时停下时继续原会话，保留前面的执行结果', async () => {
  f = flow();
  const b = await bet(f);
  const ep = await episode(f, b, [
    turn(tool('sh', { cmd: 'printf retained-output' })),
    say('继续核对。'),
    turn(tool('end_episode', { handoff: '已完成初步检查；下一步核对边界条件。' })),
  ]);
  expect(ep.requests).toHaveLength(3);
  expect(JSON.stringify(ep.requests.at(-1))).toContain('retained-output');
  expect(userTexts(ep.requests.at(-1)).join('\n')).toContain('继续');
  expect(ep.outcome.close).toEqual({ kind: 'continue', handoff: '已完成初步检查；下一步核对边界条件。' });
});
it('领域在执行中确定后，下次模型请求收到 CTF 规则并保留原执行结果', async () => {
  f = flow({ completion: false });
  const extension = ctfExtension({ queries: f.k.runStore.queries } as unknown as Parameters<typeof ctfExtension>[0]);
  f.assembler = new MelinaContextAssembler({
    queries: f.k.runStore.queries,
    prompt: (name, run) => {
      const extra = extension.prompts?.[name];
      return [loadPrompt(name), typeof extra === 'function' ? run && extra({ run }) : extra]
        .filter(Boolean)
        .join('\n\n');
    },
  });
  const b = await bet(f);
  const ep = await episode(f, b, [
    () => {
      f.k.runStore.writer.draftCompletion(f.k.run.id, {
        completion: { interpretation: '完成授权目标', criteria: ['全部验收通过'] },
        constraints: [],
        domain: 'ctf',
      });
      return turn(tool('sh', { cmd: 'printf retained-output' }));
    },
    turn(tool('sh', { cmd: 'printf next-step' })),
    turn(tool('end_episode', { handoff: '保留现有结果，继续核对剩余目标。' })),
  ]);
  const systemOf = (index: number) => {
    const content = ep.requests[index]?.find((message) => message.role === 'system')?.content;
    return typeof content === 'string' ? content : undefined;
  };
  expect(systemOf(0)).not.toContain('# CTF 执行约束');
  expect(systemOf(1)?.split('# CTF 执行约束')).toHaveLength(2);
  expect(systemOf(1)).toBe(systemOf(2));
  expect(JSON.stringify(ep.requests[2])).toContain('retained-output');
  expect(ep.outcome.close?.kind).toBe('continue');
});
it('取消丢弃未收尾调用，不记模型失败', async () => {
  f = flow();
  const b = await bet(f),
    controller = new AbortController();
  controller.abort('停止任务');
  const ep = await episode(f, b, [], { signal: controller.signal });
  expect(ep.outcome.close).toBeUndefined();
  expect(ep.outcome.failure).toBeUndefined();
});
it('自动压缩按 70% 窗口触发，保留四分之一可用输入预算', () => {
  expect(COMPACT_RATIO).toBe(0.7);
  expect(COMPACT_KEEP).toBe(0.25);
});
