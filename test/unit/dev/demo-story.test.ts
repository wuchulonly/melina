import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SubmitWatchInput } from '../../../src/core/tools.ts';
import { issues } from '../../../src/core/validate.ts';
import { demoBrain } from '../../dev/demo/story.ts';
import { brainProvider, say } from '../../integration/m0/kit.ts';
import { normalizeContext } from '../models/protocol.ts';

it('演示旁观者提交当前地图格式', async () => {
  const ctx = normalizeContext({ messages: [{ role: 'user', content: '开始', timestamp: 0 }] });
  const reply = await demoBrain({ pace: 0 })({ ctx, role: 'watcher', model: 'faux' });
  const call = reply.content.find((p) => p.type === 'toolCall');
  expect(call?.name).toBe('observation_submit');
  expect(issues(SubmitWatchInput, call?.arguments)).toEqual([]);
});
it('演示 Worker 直接使用文件工具，不要求证据图协议', async () => {
  const ctx = normalizeContext({ messages: [{ role: 'user', content: '创建文档', timestamp: 0 }] });
  const reply = await demoBrain({ pace: 0 })({ ctx, role: 'explorer', model: 'faux' });
  const call = reply.content.find((p) => p.type === 'toolCall');
  expect(call?.name).toBe('write');
  expect(call?.arguments).toMatchObject({ path: 'demo/answer.md' });
});
it('即时模拟回复让出事件循环，允许取消调用', async () => {
  const { provider } = brainProvider(() => () => say('尚未提交'));
  const controller = new AbortController();
  const ctx = normalizeContext({ messages: [{ role: 'user', content: '开始', timestamp: 0 }] });
  const cancellation = setImmediate().then(() => controller.abort());
  const response = await provider.streamSimple(provider.getModels()[0]!, ctx, { signal: controller.signal }).result();
  await cancellation;
  expect(response.stopReason).toBe('aborted');
});
