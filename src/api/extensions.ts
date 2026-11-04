// 可选运行时扩展只从显式配置的本地入口加载；普通部署不读取仓库外的实现。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { PromptName } from '../context/prompts.ts';
import { invalid } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { ToolGateway } from '../core/interfaces/gateway.ts';
import type { Observation, Run } from '../core/types.ts';
import type { BeforeTool, SubmissionGuard, ToolCheck, ToolExtension } from '../tools/session.ts';
import type { InfraDeps } from './assemble.ts';

/** 扩展复用已组装的模型调用和上下文，不另起运行时。 */
export interface RuntimeExtensionServices {
  gateway: ToolGateway;
  assembler: ContextAssembler;
}

export interface RuntimePromptContext {
  run: Run;
}

export interface RuntimeExtension {
  tools: readonly ToolExtension[];
  /** 可选的角色提示词补充；默认提示词仍由主项目提供。 */
  prompts?: Partial<Record<PromptName, string | ((context: RuntimePromptContext) => string | undefined)>>;
  /** 网关、上下文组装完成后接上扩展所需的服务。 */
  prepare?: (services: RuntimeExtensionServices) => void;
  /** 内置校验通过后执行；字符串表示拒绝，{ again } 表示等待，不占收尾返修次数。 */
  beforeClose?: SubmissionGuard;
  checkTool?: ToolCheck;
  beforeTool?: BeforeTool;
  /** 容器停止、run.recovered 落库后恢复私有状态，不自动执行工具。 */
  recover?: (runId: Id) => Promise<void>;
  /** 任务终止或删除时撤下内存中的任务状态。 */
  drop?: (runId: Id) => void;
  /** 每轮冻结前采集本分支可见的领域状态；仅返回可给模型看的脱敏材料。 */
  watcherInput?: (runId: Id, branchId: Id, input: WatcherInputSink) => Promise<string | undefined>;
}

/** 采集器只写当前分支；统一脱敏、去重后落库，再冻结观察窗口。 */
export interface WatcherInputSink {
  signal: AbortSignal;
  observations(): Observation[];
  save(tool: string, text: string, args: unknown, deduplicate?: boolean): Promise<Id>;
}

export type RuntimeExtensionFactory = (deps: InfraDeps) => RuntimeExtension;

/** SDK 可以直接提供工厂；命令行部署通过 MELINA_RUNTIME_EXTENSION 指定一个本地 ES module。 */
export function runtimeExtensions(deps: InfraDeps, factories?: readonly RuntimeExtensionFactory[]): RuntimeExtension[] {
  let selected = factories;
  if (!selected) {
    const entry = process.env.MELINA_RUNTIME_EXTENSION?.trim();
    if (!entry) return [];
    const module: unknown = createRequire(import.meta.url)(resolve(entry));
    if (
      !module ||
      typeof module !== 'object' ||
      !('apiVersion' in module) ||
      module.apiVersion !== 1 ||
      !('default' in module) ||
      typeof module.default !== 'function'
    )
      throw invalid('运行时扩展须导出 apiVersion = 1 和 default 工厂');
    selected = [module.default as RuntimeExtensionFactory];
  }
  return selected.map((factory) => {
    const extension = factory(deps);
    if (!extension || !Array.isArray(extension.tools)) throw invalid('运行时扩展须返回 tools 数组');
    return extension;
  });
}
