// Markdown 的真正渲染（marked + KaTeX + DOMPurify，连同公式的字体和样式），由 Markdown.tsx 按需加载：
// 只有结果页、终点卡上的文档和知识报告用到，不放进首屏的包里。

import { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import { renderMarkdown } from '../lib/markdown.ts';
import '../styles/markdown.css';
import { cx } from './ui.tsx';

export default function MarkdownBody({
  source,
  className,
  headingShift,
}: {
  source: string;
  className?: string | undefined;
  headingShift?: number | undefined;
}) {
  const html = useMemo(() => renderMarkdown(source, { headingShift: headingShift ?? 0 }), [source, headingShift]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown 已经用 DOMPurify 消毒
  return <div className={cx('md', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
