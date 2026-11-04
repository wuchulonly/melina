// 开发机：读 --transcript 记下的回复原文，按角色或分支出几样数，
// 改提示词、改收尾以后拿同一批世界前后各跑一次比：
// - 每次回复想了多少字（中位、p90、合计）、写了多少字、输出多少 token；
// - 收尾、提交工具被退回几次（标错的，占退回次数）、先退回不占次数的几次（收尾里能不收的部分第一次回给模型看），
//   按回给模型那句话的开头归类；
//
//   node test/dev/transcript.ts 文件… [--by role|branch] [--run <Run id>]
//
// Melina 的是 serve.ts --transcript 写的那个文件；单 agent 基线的是 score.ts --transcript 在每次尝试目录里写的
// baseline-transcript.jsonl（只有 explorer 一个角色，交付工具是 done）。只打数，不打原文。

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { TranscriptEntry } from '../../src/agents/episode.ts';
import { isClosingTool } from '../../src/core/tools.ts';
import { CLOSE_ACCEPTED } from '../../src/tools/builtins/close.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    by: { type: 'string', default: 'role' },
    run: { type: 'string' },
  },
});
if (positionals.length === 0 || (values.by !== 'role' && values.by !== 'branch')) {
  console.error('用法：node test/dev/transcript.ts 文件… [--by role|branch] [--run <Run id>]');
  process.exit(1);
}

/** 单 agent 基线交付用的工具（test/eval/baseline.ts 的 DONE_TOOL） */
const DONE = 'done';

interface Group {
  replies: number;
  thinking: number[];
  text: number;
  output: number;
  /** 收尾、提交工具标错退回的 */
  rejected: number;
  /** 没标错、也没收下的：先退回、不占次数 */
  again: number;
  reasons: Map<string, number>;
  blocked: number;
}

const groups = new Map<string, Group>();
const group = (key: string): Group => {
  let g = groups.get(key);
  if (!g) {
    g = {
      replies: 0,
      thinking: [],
      text: 0,
      output: 0,
      rejected: 0,
      again: 0,
      reasons: new Map(),
      blocked: 0,
    };
    groups.set(key, g);
  }
  return g;
};

/**
 * 回给模型那句话的开头，归类用：头一行，最多 40 个字；先退回的那种头一行是「…这次先不收：」，取下面列的第一处。
 * 引号里的（完成标准原文这类）和记录 id 换掉，同一种原因归到一起，也不把题目的内容打出来
 */
const reasonOf = (text: string) => {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const line = first.endsWith('：') ? (lines.find((l) => l.startsWith('- '))?.slice(2) ?? first) : first;
  return line
    .replace(/「[^」]*」/g, '「…」')
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '<id>')
    .slice(0, 40);
};

let lines = 0;
for (const file of positionals) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as TranscriptEntry;
    if (values.run && e.runId !== values.run) continue;
    lines++;
    const g = group(values.by === 'branch' ? `${e.role} ${e.branchId ?? e.runId}` : e.role);
    if (e.kind === 'reply') {
      g.replies++;
      g.thinking.push(e.thinking.length);
      g.text += e.text.length;
      g.output += e.usage.output;
    } else if (e.kind === 'result') {
      if (e.blocked) g.blocked++;
      else if ((isClosingTool(e.tool) || e.tool === DONE) && !e.blocked && e.text !== CLOSE_ACCEPTED) {
        // done 收下时回的话不是 CLOSE_ACCEPTED：基线只数标错的
        if (e.isError) g.rejected++;
        else if (e.tool === DONE) continue;
        else g.again++;
        const reason = reasonOf(e.text);
        g.reasons.set(reason, (g.reasons.get(reason) ?? 0) + 1);
      }
    }
  }
}

const quantile = (xs: readonly number[], q: number) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

console.log(`读了 ${positionals.length} 个文件、${lines} 条${values.run ? `（任务 ${values.run}）` : ''}\n`);
console.log(
  ['', '回复', '思考字数 中位/p90/合计', '文字字数', '输出 token', '收尾被退回', '先退回', '被拦下'].join('\t'),
);
for (const [key, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(
    [
      key,
      g.replies,
      `${quantile(g.thinking, 0.5)}/${quantile(g.thinking, 0.9)}/${sum(g.thinking)}`,
      g.text,
      g.output,
      g.rejected,
      g.again,
      g.blocked,
    ].join('\t'),
  );
}
const reasons = new Map<string, number>();
for (const g of groups.values()) for (const [r, n] of g.reasons) reasons.set(r, (reasons.get(r) ?? 0) + n);
if (reasons.size > 0) {
  console.log('\n收尾、提交没收下的原因（回给模型那句话的开头）：');
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${r}`);
}
