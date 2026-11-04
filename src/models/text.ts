// 一次无工具生成：与角色会话共用 melinaStream 的调度、重试、取消、记账。

import { MelinaError } from '../core/errors.ts';
import type { MelinaStreamFactory, TextGenerator } from '../core/interfaces/models.ts';
import type { StreamFn } from './protocol.ts';
import { normalizeContext } from './protocol.ts';
import type { MelinaModelRegistry } from './registry.ts';

export function createTextGenerator(deps: {
  stream: MelinaStreamFactory<StreamFn>;
  registry: Pick<MelinaModelRegistry, 'model'>;
}): TextGenerator {
  return async ({ meta, system, prompt }) => {
    meta.signal?.throwIfAborted();
    const response = await deps.stream(meta)(
      deps.registry.model(meta.model),
      normalizeContext({
        messages: [
          { role: 'system', content: system, timestamp: Date.now() },
          { role: 'user', content: prompt, timestamp: Date.now() },
        ],
      }),
      { signal: meta.signal, reasoning: meta.model.tier === 'strong' ? 'high' : 'low' },
    );
    const message = await response.result();
    meta.signal?.throwIfAborted();
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      throw new MelinaError('unavailable', message.errorMessage ?? '生成失败');
    const text = message.content
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n')
      .trim();
    if (!text) throw new MelinaError('unavailable', '模型没有返回文字');
    return text;
  };
}
