import type { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { CompactOptions } from '../core/interfaces/agents.ts';

/** 压缩策略由 Harness 执行；这里只桥接项目通知与失败交接。 */
export async function installCompaction(ctx: Context, options: CompactOptions): Promise<void> {
  class Compaction extends BasicCompactionEngine {
    private failed = false;

    override async compactIfNeeded(...args: Parameters<BasicCompactionEngine['compactIfNeeded']>) {
      const [agent, trigger, signal] = args;
      if (this.failed && trigger === 'pressure') return null;
      const before = ctx.tokenMeter.measure(agent.session).totalTokens;
      let result: Awaited<ReturnType<BasicCompactionEngine['compactIfNeeded']>>;
      try {
        result = await super.compactIfNeeded(...args);
      } catch (error) {
        if (!signal.aborted && !this.failed) {
          this.failed = true;
          options.onFailed?.(error);
        }
        throw error;
      }
      if (result)
        options.onCompacted?.({
          before,
          after: ctx.tokenMeter.measure(agent.session).totalTokens,
          messages: result.shadowedSeqs.length,
        });
      return result;
    }
  }

  await ctx.plugin(Compaction, {
    thresholdRatio: options.ratio,
    retainRatio: options.keep,
    // 模型的输出预留由适配器声明；摘要另设上限，避免小窗口沿用 64K 默认预留。
    headroomTokens: 0,
    maxTokens: 16_384,
  });
}
