// Scoper 的上下文：系统提示和可选的领域拼成 system，目标、工作目录和附件拼成第一条 user 消息。
// Scoper 不等人确认，开跑前一次 strong 模型调用；它可以在只读的容器里用 sh 和 read 看一眼工作目录。
// 建任务时给了完成标准（评估、API）：照样调它写约束和领域，完成标准写进上下文让它照抄（落库时也照给的用），
// 并写明看几眼就交、不动手解题。

import { notFound } from '../../core/errors.ts';
import type { Layout } from '../../core/interfaces/context.ts';
import type { RunStoreQueries } from '../../core/interfaces/store.ts';
import { scoperTools } from '../../core/tools.ts';
import type { Run } from '../../core/types.ts';

export interface DomainInfo {
  name: string;
  /** domains/<name>/description.txt 里的一句描述 */
  description: string;
}

export interface ScoperSource {
  queries: RunStoreQueries;
  prompt: (name: 'scoper') => string;
  /** 可选的领域（GlobalConfig.domains，按配置的顺序）和描述 */
  domains: () => readonly DomainInfo[];
}

export function scoperLayout(src: ScoperSource, run: Run): Layout {
  const { queries } = src;
  const basedOnSeq = queries.lastSeq();
  const domains = src.domains();
  const system = [
    src.prompt('scoper'),
    ['# 可选的领域', '', ...domains.map((d) => `- ${d.name}：${d.description || '（没有描述）'}`)].join('\n'),
  ].join('\n\n');

  const parts = [`# 目标\n\n${run.goal.statement}`];
  const where =
    run.workspace.kind === 'git-clone' ? '它是一个 git 仓库（未提交的改动也在里面）' : '它是一个普通目录（可能是空的）';
  const ws = [`# 工作目录\n\n容器里的 /workspace，只读：${where}。`];
  if (run.continuedFrom) {
    const prev = queries.getRun(run.continuedFrom);
    if (!prev) throw notFound(`接着做的那个 Run ${run.continuedFrom} 不存在`);
    ws.push(
      `这是接着上一个任务做的。上一个任务的目标是：${prev.goal.statement}\n` +
        `${prev.status === 'done' ? '工作目录是它交付的结果' : '它没做完，工作目录是它开始时的样子'}；它的附件、知识报告和没做完时的改动在 /melina/materials 下。`,
    );
  }
  parts.push(ws.join('\n\n'));
  if (run.goal.materials.length > 0) {
    parts.push(['# 附件（只读）', '', ...run.goal.materials.map((m) => `- /melina/materials/${m.name}`)].join('\n'));
  }
  // 建任务时给的完成标准：有完成标准、Scoper 又还没起草过（起草过的是它自己写的，不再让它照抄）
  const drafted = queries.events({ since: 0, runId: run.id, types: ['completion.drafted'], limit: 1 }).length > 0;
  const given = drafted ? undefined : run.goal.completion;
  if (given) {
    const lines = ['# 完成标准（建任务时已经定好）', ''];
    lines.push(`对目标的理解：${given.interpretation}`, '');
    given.criteria.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`);
    });
    lines.push(
      '',
      '这份完成标准照抄进 completion，不用改。补齐约束、领域，需要时的共用外部系统、setup 和 profile。看几眼就交，不要动手做任务本身。',
    );
    parts.push(lines.join('\n'));
    parts.push('判断好以后调用 submit_completion 一次交齐。');
  } else {
    parts.push('看清楚目标指的是什么、怎么核对以后，调用 submit_completion 一次交齐。');
  }

  return {
    role: 'scoper',
    system,
    tools: scoperTools(),
    messages: [{ role: 'user', text: parts.join('\n\n') }],
    basedOnSeq,
  };
}
