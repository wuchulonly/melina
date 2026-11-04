// @vitest-environment jsdom
// 一块画不出来时（components/ErrorBoundary.tsx）：只换掉那一块，别的照常显示；数据变了再试一次。

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Card({ text }: { text: string | undefined }) {
  if (text === undefined) throw new Error('字段没了');
  return <p>{text}</p>;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('出错兜底', () => {
  it('一张卡出错只换掉它；数据变了重新画', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draw = (text: string | undefined) =>
      act(() =>
        root.render(
          <>
            <ErrorBoundary what="这一步" resetKey={text}>
              <Card text={text} />
            </ErrorBoundary>
            <p>别的卡</p>
          </>,
        ),
      );
    await draw(undefined);
    expect(host.textContent).toContain('这一步显示不出来（页面出错了：字段没了）');
    expect(host.textContent).toContain('别的卡');
    await draw('修好了');
    expect(host.textContent).toContain('修好了');
    expect(host.textContent).not.toContain('显示不出来');
    await act(() => root.unmount());
  });
});
