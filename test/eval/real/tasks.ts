// 离线调查场景（用户 2026-10-12 定）：故障根因与未知遥测格式，检查在 Run 外面跑。
// 纯编程题和分析口径已完整给定的计算题已移出；Web/API 审计由外部任务目录维护。

import type { EvalTask } from '../task.ts';
import { incidentTask } from './incident/task.ts';
import { telemetryTask } from './telemetry/task.ts';

export function realTasks(): EvalTask[] {
  return [incidentTask(), telemetryTask()];
}
