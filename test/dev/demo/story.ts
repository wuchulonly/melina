import type { Brain } from '../../integration/m0/kit.ts';
import { candidateCall, look, say, tool, toolResults, turn } from '../../integration/m0/kit.ts';

export const ANSWER = '# 演示结果\n\n三路直解独立工作；当前会话已写入文件并核对内容。\n';
export function demoBrain(options: { pace: number }): Brain {
  return async ({ role, ctx }) => {
    if (options.pace > 0) await new Promise((r) => setTimeout(r, options.pace));
    if (role === 'scoper')
      return turn(
        tool('submit_completion', {
          domain: 'code',
          constraints: [],
          sharedSystems: [],
          completion: {
            interpretation: '在工作区创建并核对 demo/answer.md',
            criteria: ['demo/answer.md 存在且内容完整'],
          },
        }),
      );
    if (role === 'watcher')
      return turn(
        tool('observation_submit', {
          standing: '独立会话正在写入并核对演示文件',
          directions: [],
          tension: [],
          advice: '完成文件核对后提交',
        }),
      );
    if (role !== 'explorer') return say('按照当前目标继续。');
    const results = toolResults(ctx.messages);
    if (!results.some((r) => r.name === 'write' && !r.isError))
      return turn(tool('write', { path: 'demo/answer.md', content: ANSWER }));
    if (!results.some((r) => r.name === 'sh' && !r.isError)) return turn(look('cat demo/answer.md'));
    return turn(candidateCall({ claim: '演示文件已写入并核对', artifact: 'demo/answer.md' }));
  };
}
