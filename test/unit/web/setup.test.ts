// 前端开工清单给容器引擎那一步起名字，按 Melina 系统状态里那句话的说法认（web/src/lib/setup.ts sandboxTitle）：
// 后端的说法改了这里会挂。

import { describe, expect, it } from 'vitest';
import { containerNotices } from '../../../src/api/status.ts';
import { sandboxTitle } from '../../../web/src/lib/setup.ts';

const ok = {
  engine: 'ok' as const,
  kind: 'podman',
  rootless: true,
  memoryLimit: true,
  pidsLimit: true,
  missingImages: [] as string[],
};

/** 这一种检查结果下，系统状态里 sandbox 那条 error 的话 */
function sandboxText(check: Parameters<typeof containerNotices>[0]): string {
  const n = containerNotices(check).find((x) => x.kind === 'sandbox' && x.level === 'error');
  if (!n) throw new Error('没有 sandbox 的 error');
  return n.text;
}

describe('开工清单认得出容器引擎的几种报错', () => {
  it('没装', () => {
    expect(sandboxTitle(sandboxText({ engine: 'missing' }))).toBe('装好容器引擎');
  });

  it('装了用不了（含按分支容器的参数起不来、没装 slirp4netns）', () => {
    expect(sandboxTitle(sandboxText({ engine: 'broken', error: '按分支容器的参数起不来容器：…' }))).toBe(
      '修好容器引擎',
    );
  });

  it('冻不住容器', () => {
    expect(sandboxTitle(sandboxText({ ...ok, freeze: { ok: false, error: 'cannot pause the container' } }))).toBe(
      '让容器引擎冻得住容器',
    );
  });

  it.runIf(process.platform === 'linux')('Linux 上不是 rootless', () => {
    expect(sandboxTitle(sandboxText({ ...ok, rootless: false }))).toBe('把容器引擎配成 rootless 的');
  });
});
