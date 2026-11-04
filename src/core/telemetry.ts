import Type, { type Static } from 'typebox';
import { Arr, Enum, Ids, Num, Obj, Opt, Str } from './schema.ts';

export const TaskProfile = Obj(
  {
    tags: Arr(Str({ pattern: '^[a-z][a-z0-9-]{0,31}$' }), {
      maxItems: 12,
      uniqueItems: true,
      description: '技术分类，例如 web、java-deserialization、crypto；只填分类，不填地址、路径或标识符',
    }),
    hasSource: Type.Union([Type.Boolean(), Type.Null()], { description: '是否确认有源码；未确认用 null' }),
    attachmentScale: Enum(['unknown', 'none', 'small', 'large'], { description: '已看到的附件规模，未检查用 unknown' }),
    estimatedMinutes: Type.Union([Num({ minimum: 1, maximum: 480 }), Type.Null()], {
      description: '基于已知条件估计解题分钟数；未知用 null，不是承诺或硬限制',
    }),
    confidence: Num({ minimum: 0, maximum: 1, description: '画像的证据可信度，0 到 1' }),
  },
  { description: '画像变化时填写；仅技术分类、附件规模和耗时，不含目标地址、路径、命令或凭证' },
);
export type TaskProfile = Static<typeof TaskProfile>;

// stage 描述任务当前的工作阶段；recon、hypothesis_testing 不表示分支种类或运行模式。
export const SemanticDigest = Obj(
  {
    stage: Enum(
      [
        'unknown',
        'recon',
        'analysis',
        'hypothesis_testing',
        'exploit_verification',
        'blind_fuzzing',
        'implementation',
        'verification',
        'blocked',
      ],
      { description: '当前证据支持的阶段，不按工具调用数量推断' },
    ),
    trajectory: Enum(['unknown', 'advancing', 'systematic_elimination', 'repeated_blocker', 'waiting'], {
      description: '新增阴性结果是有计划地缩小范围，还是在相同障碍上重复；证据不足用 unknown',
    }),
    bottleneck: Enum(
      [
        'unknown',
        'none',
        'missing_credential',
        'env_instability',
        'missing_dependency',
        'missing_source',
        'capability_gap',
        'compute_wait',
        'external_wait',
      ],
      { description: '当前阻塞原因；失败或没新信息本身不证明存在阻塞' },
    ),
    confidence: Num({ minimum: 0, maximum: 1, description: '上述态势判断的证据可信度，0 到 1' }),
    evidence: Ids({
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      description: '本轮冻结窗口内支持判断的记录 id，1 到 4 条',
    }),
    profile: Opt(TaskProfile),
  },
  {
    description:
      '态势变化或证据更充分时填写；省略不生成新报告，也不刷新旧报告时间。阶段与阻塞依据证据判断，不由次数或时间推断，也不代替验收',
  },
);
export type SemanticDigest = Static<typeof SemanticDigest>;
