// 给模型看的文字不带评估题。
// 1. 通用的做事原则只写在 src/prompts/principles.md 一处：Explorer 的系统提示和单 agent 基线原样拿这一份，两边比的才是架构。
// 2. 评估世界（test/sim、test/eval/real）特有的说法不进生产代码的字符串（src/ 下所有字符串字面量，注释不算）、各角色的提示词和
//    工具说明、基线的提示。这里只拦已知的词：新题型照样靠规矩（不照着某道题的失败写提示）和留出集。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  loadPrinciples,
  loadPrompt,
  loadSharedPrompt,
  PRINCIPLES_MARK,
  type PromptName,
} from '../../../src/context/prompts.ts';
import { BASELINE_SYSTEM } from '../../eval/baseline.ts';

const ROOT = join(import.meta.dirname, '../../..');
// 挑版原来漏了， 加巡检器时一起补上
const ROLES: PromptName[] = ['explorer', 'scoper', 'selection', 'watcher'];

/**
 * 评估世界特有的说法：隐藏规则、设计好的坑、做对的关键动作里的词，以及–57 照着这些题写进提示、 删掉的句子里的说法。
 * 要用其中某个词讲 Melina 自己的机制，先想想能不能换一个和这批题无关的说法；真绕不开，在这里写清为什么再放行。
 * 只收具体到只有这批题才会这样说的：根因、复盘、网关、连接池、冷启动、校验这类到处都说的词不收（Melina 自己的文字也用，
 * 拦它们只会误伤）；「最有利的条件」是排除即试验这个机制的定义，不收。
 */
const WORLD_WORDS: readonly string[] = [
  // 照题写进提示、 删掉的说法：遥测解码（样本、校验和、单位、替代规则）
  '重建最小预测',
  '真实输入差异',
  '实际输入差异',
  '替代规则',
  '影响目标答案',
  '两处测的是同一个量',
  '答案已知的材料',
  '已知答案的材料',
  '字节完整',
  '样本复现',
  '样本能复现',
  '样本能跑通',
  '写读一致',
  '分布接近',
  '数量级接近',
  '单位相同',
  '物理量级',
  '额外样本',
  // 灌装机（面板之外的状态、同一状态不同历史）
  '可见状态',
  '认为足够的状态',
  '到达它的历史不同',
  '操作历史',
  '状态充分',
  '按状态去重',
  '扩大枚举',
  '模型算出不可达',
  '摸不出规律',
  // 作业调参（共享预算、联合区、只差一处的对照、把其余的量重调）
  '条件组合',
  '几个量同时取的值',
  '其余的量重新调一遍',
  '抢同一份',
  '只差这一处的对照',
  '混在一起的其它改动',
  '推到可行的最大',
  '共享预算',
  '联合区',
  '写成全称',
  // 订单服务、部署清单（遍历编号、归档、校验器、逐个穷举）
  '遍历编号',
  '挨个试接口',
  '列表接口',
  '全部订单',
  '取数算账',
  '区间的边界',
  '金额的单位',
  '看到的这批就是全部',
  '列表里看不到',
  '先把整份交给',
  '文档里没写的规则',
  '逐个穷举',
  '校验器',
  '校验和',
  '多数题',
  // 仿真世界的名词（test/sim）
  '灌装机',
  'FC-3',
  'STANDBY',
  'LOCKOUT',
  '泄压',
  '联锁',
  '订单',
  'include_archived',
  'ORD-',
  'successor-version',
  '部署清单',
  'services.json',
  'deploy.json',
  'deploy.md',
  '可用区',
  '保留端口',
  '作业调参',
  'cache_mb',
  'output_checksum',
  '悬崖',
  '热数据',
  // 真实任务的名词（test/eval/real）
  'KTLM',
  'varint',
  'zigzag',
  '传感器网关',
  '厂家工具',
  '固件',
  'unknown1.bin',
  'answer.json',
  'jobq',
  'Buchungstag',
  '对账单',
  'shellport',
  'BREError',
  'cronspec',
  'semverlite',
  'max_satisfying',
  'ignorefile',
  'IgnoreRules',
  'fetch_all',
  'monthly_summary',
  'acme-api',
  'miniweb',
  'before_request',
  '越权',
  'RFC 4180',
  'access.log',
  'events.csv',
  'dictionary.md',
  'orders.csv',
  'refunds.csv',
  '转化率',
  '显著性',
  '退款',
  '外币',
  '月报',
];

/** src/ 下的 .ts 文件（不含 .d.ts） */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** 一个文件里的字符串字面量和模板的字面部分（注释不算：注释写给人看，可以讲来历） */
function stringsIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('通用的做事原则两边一份', () => {
  it('Explorer 的系统提示和单 agent 基线都原样带着 principles.md', () => {
    const principles = loadPrinciples();
    expect(principles.length).toBeGreaterThan(0);
    expect(loadPrompt('explorer')).toContain(principles);
    expect(BASELINE_SYSTEM).toContain(principles);
  });

  it('环境、凭证、交付说明在 Explorer 与基线中原样共用且只出现一次', () => {
    const prompts = [loadPrompt('explorer'), BASELINE_SYSTEM];
    for (const name of ['environment', 'credentials', 'workspace', 'delivery', 'sources'] as const) {
      const fragment = loadSharedPrompt(name);
      for (const prompt of prompts) expect(prompt.split(fragment)).toHaveLength(2);
    }
    expect(loadPrompt('scoper')).toContain(loadSharedPrompt('credentials'));
  });

  it('角色提示里没有剩下没换掉的占位符', () => {
    for (const role of ROLES) expect(loadPrompt(role), role).not.toContain(PRINCIPLES_MARK);
  });
});

describe('给模型看的文字不带评估题', () => {
  it('各角色的提示词、通用原则、基线的提示里没有评估世界特有的说法', () => {
    const texts: Array<[string, string]> = [
      ...ROLES.map((role): [string, string] => [`src/prompts/${role}.md`, loadPrompt(role)]),
      ['src/prompts/principles.md', loadPrinciples()],
      ['test/eval/baseline.ts 的 BASELINE_SYSTEM', BASELINE_SYSTEM],
    ];
    const hits = texts.flatMap(([where, text]) =>
      WORLD_WORDS.filter((w) => text.includes(w)).map((w) => `${where}：${w}`),
    );
    expect(hits).toEqual([]);
  });

  it('src/ 的字符串里（工具说明、runtime 追加的提示、拒绝理由都在这里）没有评估世界特有的说法', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      for (const s of stringsIn(file)) {
        for (const w of WORLD_WORDS) if (s.includes(w)) hits.push(`${relative(ROOT, file)}：${w}`);
      }
    }
    expect([...new Set(hits)]).toEqual([]);
  }, 60_000); // 要把 src/ 下一百多个文件都解析一遍，机器忙时几秒
});
