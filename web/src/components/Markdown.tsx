// 显示一段 Markdown（带公式），先消毒（lib/markdown.ts）。 的结果页和知识报告用它。
// 渲染那部分（marked、KaTeX、DOMPurify）按需加载（MarkdownBody.tsx），加载完之前先放几行骨架。
// 加载失败（Melina 重新打包过、正在重启）时退回原文显示，别让整页跟着没了；下次再用到时重新加载一次。

import { Component, lazy, type ReactNode, Suspense } from 'react';
import { cx, Skeleton } from './ui.tsx';

function loadBody() {
  return import('./MarkdownBody.tsx');
}

let MarkdownBody = lazy(loadBody);

/** 加载渲染部分出错时显示原文；lazy 会记住失败，换一个新的，下次挂上时再试 */
class LoadFailed extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    MarkdownBody = lazy(loadBody);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * headingShift：文档的标题整体降几级。默认 1：用到它的结果页、终点卡、知识报告都在任务页里，页面上已经有 h1（任务目标），
 * 文档自己的一级标题成了第二个 h1，读屏按标题跳时分不清哪个是页面的
 */
export function Markdown({
  source,
  className,
  headingShift = 1,
}: {
  source: string;
  className?: string;
  headingShift?: number;
}) {
  return (
    <LoadFailed fallback={<PlainText text={source} {...(className ? { className } : {})} />}>
      <Suspense
        fallback={
          <div className={cx('md md-loading', className)} aria-busy="true">
            <Skeleton width="42%" height={18} />
            <Skeleton />
            <Skeleton />
            <Skeleton width="76%" />
          </div>
        }
      >
        <MarkdownBody source={source} className={className} headingShift={headingShift} />
      </Suspense>
    </LoadFailed>
  );
}

/** 工具输出这类纯文本：React 自己会转义，原样显示，保留换行 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return <pre className={cx('plain-text', className)}>{text}</pre>;
}
