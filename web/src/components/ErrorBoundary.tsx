// 渲染出错的兜底：一张卡片（或一页）出错，只把它换成一句话，别让整页白屏。
// 模型写的内容千奇百怪，某个字段的样子没想到时，坏的只该是那一格。

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** 换了这个值就重新试一次（比如运行进度更新、切换页面） */
  resetKey?: unknown;
  /** 出错时这一块叫什么：「这一步」「这一页」 */
  what?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Melina 页面有一块画不出来', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="render-error" role="alert">
        {this.props.what ?? '这一块'}显示不出来（页面出错了：{error.message}）。刷新试试；还不行就把这句话告诉开发的人。
      </div>
    );
  }
}
