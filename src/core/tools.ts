// 工具协议：求解会话通过文字交接或最终交付收尾；Watcher 独立维护旁观地图。
import Type, { type Static, type TSchema } from 'typebox';
import { invalid } from './errors.ts';
import { Arr, Bool, Enum, IdS, Ids, Nat, Obj, Opt, Str, Text } from './schema.ts';
import { SemanticDigest } from './telemetry.ts';
import {
  type Observation,
  ScoperOutput,
  WATCH_ID_PATTERN,
  WatchAttempt,
  type WatchBody,
  WatchExperiment,
  WatchStatus,
} from './types.ts';
export const TOOL = {
  sh: 'sh',
  read: 'read',
  edit: 'edit',
  write: 'write',
  deliver: 'deliver',
  endEpisode: 'end_episode',
  submitCompletion: 'submit_completion',
  submitWatch: 'observation_submit',
  observationContext: 'observation_context',
} as const;
export type ToolName = (typeof TOOL)[keyof typeof TOOL] | (string & {});
export const ENV_TOOLS = [TOOL.sh, TOOL.read, TOOL.edit, TOOL.write] as const;
export type EnvToolName = ToolName;
export const CLOSING_TOOLS = [TOOL.endEpisode, TOOL.submitCompletion, TOOL.submitWatch] as const;
export type ClosingToolName = (typeof CLOSING_TOOLS)[number];
export function isEnvTool(name: string): name is EnvToolName {
  return (ENV_TOOLS as readonly string[]).includes(name);
}
export function isClosingTool(name: string): name is ClosingToolName {
  return (CLOSING_TOOLS as readonly string[]).includes(name);
}
export function countsAsToolCall(o: Pick<Observation, 'role' | 'branchId' | 'tool'>): boolean {
  return o.role === 'explorer' && o.branchId !== undefined && isEnvTool(o.tool);
}
export const ShArgs = Obj({
  cmd: Str({
    description:
      '交给 bash 执行的命令，可用管道和重定向，默认开启 pipefail；管道任一阶段失败会返回非零。预期的无匹配或提前截断须显式处理，工具执行失败不能记为有效阴性结果。批量任务估算总预算并限制并发；耗时不确定时分批保存进度或用 background，程序须设总期限。内置批量助手的用法见 melina-batch --help',
  }),
  expect: Opt(Str({ description: '可选：需要验证的具体预期观测' })),
  timeoutMs: Opt(
    Nat({
      minimum: 1000,
      description:
        '整条前台命令的总时限（毫秒，含等待和所有子命令），有输出也不会续期；默认 sh.timeoutMs（初始 120000），最多 300000（5 分钟）；到时终止进程，已产生的文件和外部影响不会回滚。更长的任务用 background，之后看日志',
    }),
  ),
  background: Opt(
    Bool({
      description:
        '后台运行：立即返回 pid 和日志文件路径，进程跨调用存活；timeoutMs 不限制后台运行时长，启动成功不表示命令已完成',
    }),
  ),
});

export type ShArgs = Static<typeof ShArgs>;

export const ReadArgs = Obj({
  path: Str({
    description: 'workspace 里的文件，或 /melina 下的只读文件（/melina/materials 附件、/melina/artifacts 原始输出）',
  }),
  offset: Opt(Nat({ minimum: 1, description: '从第几行开始，从 1 数，默认 1' })),
  limit: Opt(Nat({ minimum: 1, description: '最多读几行' })),
});

export type ReadArgs = Static<typeof ReadArgs>;

export const EditArgs = Obj({
  path: Str({ description: 'workspace 里的文件' }),
  old: Str({ description: '要替换的原文，在文件里必须唯一（all 为 true 时除外）' }),
  new: Text({ description: '替换成的内容' }),
  all: Opt(Bool({ description: '为 true 时替换所有出现的地方' })),
});

export type EditArgs = Static<typeof EditArgs>;

export const WriteArgs = Obj({
  path: Str({ description: 'workspace 里的文件，没有就新建' }),
  content: Text({ description: '整个文件的内容' }),
});

export type WriteArgs = Static<typeof WriteArgs>;

export const SubmitCompletionArgs = Obj(ScoperOutput.properties);

export type SubmitCompletionArgs = Static<typeof SubmitCompletionArgs>;

const WatchId = (description: string) => Str({ pattern: WATCH_ID_PATTERN, description });

const WatchDirectionInput = Obj({
  id: WatchId('跨版稳定的方向编号，如 cache-rates'),
  direction: Str({ description: '求解方向的类别和对象' }),
  status: WatchStatus,
  result: Str({
    description: '当前结论及关键实测条件与结果；untried 简述支持线索；引用须同时填入 evidence',
  }),
  evidence: Arr(Str(), {
    uniqueItems: true,
    description: '必填：逐字复制本轮提供的证据短码，如 o42；实测结果须有执行依据；无依据的备选填 []',
  }),
  doubt: Opt(Str({ description: '影响判断的关键疑点或证据缺口' })),
  experiment: Opt(WatchExperiment),
  retired: Opt(Bool({ description: 'true 归档方向，false 恢复；省略沿用，新方向默认 false' })),
  priority: Opt(Nat({ minimum: 1, maximum: 4, description: '同类方向内的展示优先级，1 最高；省略沿用' })),
});

const WatchLifecycleInput = Obj({
  id: WatchId('已存在的方向编号；仅归档或恢复时只交 id 与 retired，结论和尝试由宿主保留'),
  retired: Bool({ description: 'true 归档，false 恢复；不再需要验证不等于 failed' }),
});

const WatchTensionInput = Type.Union([Arr(Str(), { maxItems: 0 }), Arr(Str(), { minItems: 2, maxItems: 2 })], {
  description: 'CONFLICTS：本窗口主代理两句不能同时成立的判断原话；没有则省略或 []，单句疑点写入 doubt',
});

/** 模型只更新方向结论和一层证据；尝试记录由宿主生成。 */
export const SubmitWatchInput = Obj({
  standing: Str({
    description: '当前最有解释力的工作假设及关键线索；尚待验证的部分不能写成事实',
  }),
  telemetry: Opt(
    Type.Union([
      Obj(
        {
          ...SemanticDigest.properties,
          evidence: Arr(Str(), {
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            description: '支持态势判断的执行证据短码，如 o42，1 到 4 条',
          }),
        },
        {
          description:
            '态势或画像变化时填完整报告；省略表示本轮未更新，保留上次报告的原时间；null 明确撤回旧态势；不为此额外调查',
        },
      ),
      Type.Null(),
    ]),
  ),
  directions: Opt(
    Arr(Type.Union([WatchDirectionInput, WatchLifecycleInput]), {
      maxItems: 30,
      description:
        '只交变化，未提交自动沿用；更新结论须填 evidence；仅归档/恢复交 {id, retired}，保留原结论与尝试；不能把未试方向因不再需要而改成 failed',
    }),
  ),
  tension: Opt(WatchTensionInput),
  forbid: Opt(
    Arr(Str(), {
      description: '本版领域策略标记，含义见扩展；省略或 [] 清除旧标记',
    }),
  ),
  advice: Text({
    description: '当前决策焦点：真正的阻塞点与最值得消除的不确定性；对应方向用 experiment 给出有限验证',
  }),
});

export type SubmitWatchInput = Static<typeof SubmitWatchInput>;

/** 宿主内部结构：补齐省略值，解析证据短码并为尝试编号。 */
export const SubmitWatchArgs = Obj({
  ...Type.Omit(SubmitWatchInput, ['directions', 'tension', 'telemetry']).properties,
  telemetry: Opt(Type.Union([SemanticDigest, Type.Null()])),
  directions: Arr(
    Obj({
      ...Type.Omit(WatchDirectionInput, ['evidence']).properties,
      evidence: Ids({ description: '结论的关键依据 id；省略时由宿主补为 []' }),
      attempts: Arr(WatchAttempt, { description: '宿主根据新增执行依据生成并编号的尝试记录' }),
    }),
    { maxItems: 30 },
  ),
  tension: WatchTensionInput,
});

export type SubmitWatchArgs = Static<typeof SubmitWatchArgs>;

export function watchFromArgs(input: SubmitWatchInput, previous?: WatchBody): SubmitWatchArgs {
  return {
    ...input,
    directions: (input.directions ?? []).map((direction) => {
      if ('status' in direction) return { ...direction, evidence: direction.evidence ?? [], attempts: [] };
      const old = previous?.directions.find((d) => d.id === direction.id);
      if (!old) throw invalid(`方向 ${direction.id} 尚不存在，不能只归档或恢复`);
      const { archivedAttempts: _archived, ...fields } = old;
      return { ...fields, retired: direction.retired, evidence: [...old.evidence], attempts: [] };
    }),
    tension: input.tension ?? [],
  };
}

export const ObservationContextArgs = Obj({
  part: Opt(
    Enum(['record', 'output'], {
      description: 'record 读取记录字段；output 读取工具原文。观测默认 output，其他材料默认 record',
    }),
  ),
  column: Opt(Nat({ description: '起始行内的 UTF-16 偏移，默认 0；续读原样使用返回的 next.column' })),
  contextRefs: Opt(Arr(Str(), { maxItems: 16, description: '展开折叠的叙述材料，记录 ID 或 o42；不能用作执行证据' })),
  evidenceRefs: Opt(
    Arr(Str(), {
      maxItems: 16,
      uniqueItems: true,
      description: '证据短码（如 o42）或原文句柄；摘要足够即可提交，需要细节时再查询',
    }),
  ),
  assessmentIds: Opt(
    Arr(Str(), {
      maxItems: 8,
      uniqueItems: true,
      description: '展开上一版方向的全部尝试、结论和疑点；空数组列出方向索引，可用 offset/limit 翻页，含退休方向',
    }),
  ),
  offset: Opt(Nat({ minimum: 1, description: '证据原文从第几行开始，默认 1；后续页沿用相同 evidenceRefs' })),
  limit: Opt(Nat({ minimum: 1, maximum: 400, description: '每份证据原文最多读多少行，默认 200' })),
  query: Opt(
    Obj(
      {
        text: Opt(Str({ description: '在本轮截止点以前可见的记录中查找文字' })),
        beforeSeq: Opt(Nat({ description: '只列出这个序号以前的记录，用来向前翻历史' })),
        limit: Opt(Nat({ minimum: 1, maximum: 100, description: '最多列出多少条记录，默认 20' })),
      },
      { description: '按关键词或序号发现历史证据 id；结果按从新到旧排列，再用 evidenceRefs 展开原文' },
    ),
  ),
});

export type ObservationContextArgs = Static<typeof ObservationContextArgs>;

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: TSchema;
  /** 可选扩展的环境工具沿用 Explorer 的次数、取消和收尾线。 */
  environment?: boolean;
  /** 必须在单独一轮调用；由网关统一检查。 */
  standalone?: boolean;
}
export const EnvToolResult = Obj({ summary: Text(), path: Opt(Str()) });
export type EnvToolResult = Static<typeof EnvToolResult>;
export const SubmitCandidateArgs = Obj({
  claim: Str({ description: '实际完成了什么，以及验证结果' }),
  artifact: Opt(Str({ description: '工作区内的单个交付物路径' })),
});
export type SubmitCandidateArgs = Static<typeof SubmitCandidateArgs>;
export const DeliverArgs = SubmitCandidateArgs;
export type DeliverArgs = Static<typeof DeliverArgs>;
export const EndEpisodeArgs = Obj({
  handoff: Str({ maxLength: 8000, description: '当前进展、已控资产、未解问题、下一步和服务恢复方式' }),
});
export type EndEpisodeArgs = Static<typeof EndEpisodeArgs>;
export const EndEpisodeCall = Obj({
  handoff: Opt(EndEpisodeArgs.properties.handoff),
  candidate: Opt(SubmitCandidateArgs),
});
export type EndEpisodeCall = Static<typeof EndEpisodeCall>;
export type CloseOutcome = ({ kind: 'continue' } & EndEpisodeArgs) | ({ kind: 'candidate' } & SubmitCandidateArgs);
const spec = (name: ToolName, description: string, parameters: TSchema): ToolSpec => ({
  name,
  description,
  parameters,
});
export const TOOL_SPECS = {
  sh: spec(TOOL.sh, '在分支容器的工作区执行 bash 命令；长输出按只读路径取回。', ShArgs),
  read: spec(TOOL.read, '按行读取文件。', ReadArgs),
  edit: spec(TOOL.edit, '替换文件中的唯一匹配内容。', EditArgs),
  write: spec(TOOL.write, '写入完整文件。', WriteArgs),
  deliver: spec(TOOL.deliver, '保存可用工作区快照，继续当前会话。必须单独调用。', DeliverArgs),
  endEpisode: spec(
    TOOL.endEpisode,
    '最终交付填 candidate，暂停或必要交接填 handoff；只填一种，必须单独调用。',
    EndEpisodeCall,
  ),
  submitCompletion: spec(
    TOOL.submitCompletion,
    '提交完成标准、约束、领域及准备命令。必须单独调用。',
    SubmitCompletionArgs,
  ),
  submitWatch: spec(TOOL.submitWatch, '更新旁观地图。必须单独调用。', SubmitWatchInput),
  observationContext: spec(
    TOOL.observationContext,
    '按需读取冻结窗口的执行原文、宿主状态和历史判断；材料足够即可提交。',
    ObservationContextArgs,
  ),
} as const;
export function explorerTools(): ToolSpec[] {
  const s = TOOL_SPECS;
  return [s.sh, s.read, s.edit, s.write, s.deliver, s.endEpisode];
}
export function scoperTools(): ToolSpec[] {
  const s = TOOL_SPECS;
  return [s.sh, s.read, s.submitCompletion];
}
export function watcherTools(references?: readonly string[]): ToolSpec[] {
  const s = TOOL_SPECS;
  if (!references) return [s.observationContext, s.submitWatch];
  const parameters = structuredClone(SubmitWatchInput);
  const short = [...new Set(references.filter((ref) => /^o[1-9][0-9]*$/.test(ref)))];
  // 稳定短码只可从冻结目录选择；完整记录 ID 仍由同一窗口校验，不推算邻号。
  const reference = short.length ? Type.Union([Enum(short), IdS()]) : IdS();
  const directionEvidence: { items: TSchema } = parameters.properties.directions.items.anyOf[0].properties.evidence;
  const telemetryEvidence: { items: TSchema } = parameters.properties.telemetry.anyOf[0].properties.evidence;
  directionEvidence.items = reference;
  telemetryEvidence.items = reference;
  return [s.observationContext, { ...s.submitWatch, parameters }];
}
