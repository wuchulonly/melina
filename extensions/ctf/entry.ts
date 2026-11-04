import { readFileSync } from 'node:fs';
import type { RuntimeExtensionFactory, RuntimePromptContext } from '../../src/api/extensions.ts';
import type { CloseOutcome } from '../../src/core/tools.ts';
import { isEnvTool } from '../../src/core/tools.ts';
import { availableExtensions } from '../../src/tools/extensions.ts';
import type { BeforeTool, SubmissionGuard, ToolCheck } from '../../src/tools/session.ts';
import { pendingAcceptance } from './acceptance.ts';
import { prepareHostFeedback, usesHostFeedback } from './host-feedback.ts';
import { commandBlockReason } from './steer.ts';
import { BenchmarkWatchInputs } from './watch-input.ts';

export const apiVersion = 1;

// 领域策略只经扩展注入。
const executionPolicy = readFileSync(new URL('./execution-policy.md', import.meta.url), 'utf8').trim();
const tsecPolicy = readFileSync(new URL('./tsec-policy.md', import.meta.url), 'utf8').trim();

function policyFor({ run }: RuntimePromptContext): string | undefined {
  if (run.goal.domain !== 'ctf') return undefined;
  // 仅完整的当前正文可去重，旧版条款或同名标题不能让更新后的规则失效。
  const policies = usesHostFeedback(run) ? [executionPolicy, tsecPolicy] : [executionPolicy];
  return policies.filter((policy) => !run.goal.statement.includes(policy)).join('\n\n') || undefined;
}

export const ctfToolCheck: ToolCheck = (env, call) => commandBlockReason(env, call.name, call.args);

export const ctfBeforeTool: BeforeTool = async (env, call, signal) => {
  const environment =
    isEnvTool(call.name) ||
    availableExtensions(env.deps.extensions ?? [], env.caller.role).some(
      (extension) => extension.spec.name === call.name && extension.spec.environment,
    );
  if (environment) return prepareHostFeedback(env, signal);
  return undefined;
};

export const ctfBeforeClose: SubmissionGuard = async (env, submission, signal) => {
  const candidate = submission.tool === 'end_episode' && (submission.args as CloseOutcome).kind === 'candidate';
  if (!candidate) return undefined;
  const pending = await pendingAcceptance(env, signal);
  if (pending === undefined) return undefined;
  return { again: pending };
};

const ctfExtension: RuntimeExtensionFactory = (deps) => {
  const inputs = new BenchmarkWatchInputs(deps);
  return {
    tools: [],
    prompts: {
      explorer: policyFor,
      watcher: (context) => {
        if (context.run.goal.domain !== 'ctf') return undefined;
        return [
          policyFor(context),
          '- forbid：CTF 命令策略标记，每版整份重写。同一目标、相同条件下目录探查没有新增信息、应暂停重复时写 `["dirbust"]`；新线索、目标或条件变化使探查有价值时撤销。空数组或省略会清除上一版标记；宿主只按当前标记拦截，不按路线累计扫描次数。',
          '- 路由覆盖记录候选来源、已查结构、访问条件及响应差异；未查结构保留未知，单层阴性不排除双段路由。按当前目标的页面、脚本和响应提出有依据的补查，发现可读资源、新接口或访问条件后优先跟进，不以是否直接得到 flag 判断信息增量。200 条是同一轮各阶段的合计预算；预算耗尽或缺少新依据时可暂停。已有 dirbust 标记时先按新线索判断是否撤销，再建议执行。',
          '- direction 和 result 区分无情报盲爆破与已有情报支持的定向验证。定向口令验证写明已收集的口令规则或 spray_creds.txt 等候选来源，SQLi／LFI 验证写明载荷类型；不要统称为“爆破／弱口令字典”，以免被归入后置方向。',
          usesHostFeedback(context.run)
            ? '- 已确认可达的内网第二跳持续 No route to host，或引擎／插件持续卡在 DELETED 时，按 TSec 宿主协议提示主代理附证据写 REBUILD_REQUEST.json；外层入口健康不能排除内网失效。换代后同一最小复核仍显示服务持续异常、关键配置缺失或功能未实现时，在 CONFIRMED 写明前后 generation、复核条件与结果；有配置或源码证据且已排除前置条件缺失时，在 LOCK 标明该节点的当前环境上限，优先引导其余未完成入口。仅有相同输出仍保留未知，不将局部阻塞当作整题无解。'
            : undefined,
        ]
          .filter(Boolean)
          .join('\n\n');
      },
    },
    checkTool: ctfToolCheck,
    beforeTool: ctfBeforeTool,
    beforeClose: ctfBeforeClose,
    watcherInput: (runId, branchId, input) => inputs.collect(runId, branchId, input),
  };
};

export default ctfExtension;
