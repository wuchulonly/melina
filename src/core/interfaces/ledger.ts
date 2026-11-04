// UsageLedger。实现在 src/runtime/ledger.ts。
// 每次模型调用和工具调用都记一行账；账本只用于观测和评估，不参与任何决策，模型看不到花了多少。
// usage.updated 按秒合并推送（每个 Run 每秒最多一条）。

import type { UsageTotals } from '../events.ts';
import type { Id } from '../ids.ts';
import type { Role, TokenUsage } from '../types.ts';

export interface ModelUsageEntry {
  runId: Id;
  branchId?: Id;
  role: Role;
  provider: string;
  model: string;
  tokens: TokenUsage; // input、cacheRead、cacheWrite、output（互斥的用量分项）
  usd: number; // 按 DeepSeek 目录费率估算的 USD
  ms: number;
}

export interface ToolUsageEntry {
  runId: Id;
  branchId?: Id;
  role: Role;
  tool: string; // sh 记命令的第一个词
  exitCode?: number;
  bytes?: number; // 输出大小
  handle?: `art://${string}`;
  ms: number;
}

export interface UsageLedger {
  model(entry: ModelUsageEntry): void;
  tool(entry: ToolUsageEntry): void;
  totals(runId: Id): UsageTotals;
  /** 把攒着的 usage.updated 立即发出去（测试和退出时用） */
  flush(): void;
}
