import type { SubmitWatchArgs } from '../../src/core/tools.ts';

/** RunStore 夹具的宿主尝试记录不进入模型工具参数；非法测试输入原样交给 schema 校验。 */
export function watchInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('directions' in input) || !Array.isArray(input.directions)) return input;
  return {
    ...input,
    directions: input.directions.map((direction: SubmitWatchArgs['directions'][number]) => {
      if (!direction || !Array.isArray(direction.attempts)) return direction;
      const { attempts: _attempts, ...fields } = direction;
      return fields;
    }),
  };
}
