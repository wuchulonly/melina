import { describe, expect, it, vi } from 'vitest';
import { containerRuntimeFor } from '../../../src/api/assemble.ts';
import { DEFAULT_GLOBAL_CONFIG, DEFAULT_RUN_CONFIG } from '../../../src/core/config.ts';
import type { ContainerRef } from '../../../src/core/interfaces/container.ts';
import type { Run } from '../../../src/core/types.ts';
import { SecretRedactor } from '../../../src/tools/redact.ts';

const captured = vi.hoisted(() => ({ maxBackground: undefined as ((ref: ContainerRef) => number) | undefined }));

vi.mock('../../../src/tools/container.ts', () => ({
  detectEngine: () => ({ kind: 'docker' }),
  PodmanRuntime: class {
    constructor(options: { maxBackground: (ref: ContainerRef) => number }) {
      captured.maxBackground = options.maxBackground;
    }
  },
}));

describe('容器的 Run 配置', () => {
  it.each([
    { name: 'sandbox-with-an-arbitrary-name', runId: 'run-mixedCase', expected: 11 },
    {
      name: 'melina-01K6F1W3S2A8Q0Q6YH7J5M4N3P-branch',
      runId: undefined,
      expected: DEFAULT_RUN_CONFIG.sh.maxBackground,
    },
    { name: 'sandbox-with-an-arbitrary-name', runId: 'missing-run', expected: DEFAULT_RUN_CONFIG.sh.maxBackground },
  ])('按显式 runId 取后台进程上限：$runId', ({ name, runId, expected }) => {
    const queries = {
      getRun: vi.fn((id: string) =>
        id === 'run-mixedCase' ? ({ config: { sh: { maxBackground: 11 } } } as Run) : undefined,
      ),
    };
    containerRuntimeFor({
      env: {},
      config: { global: () => DEFAULT_GLOBAL_CONFIG },
      redactor: new SecretRedactor(),
      queries,
    });
    expect(captured.maxBackground?.({ id: 'container-id', name, ...(runId ? { runId } : {}) })).toBe(expected);
    expect(queries.getRun.mock.calls).toEqual(runId ? [[runId]] : []);
  });

  it('没有任务查询器时使用默认值', () => {
    containerRuntimeFor({
      env: {},
      config: { global: () => DEFAULT_GLOBAL_CONFIG },
      redactor: new SecretRedactor(),
    });
    expect(captured.maxBackground?.({ id: 'container-id', name: 'sandbox', runId: 'run-id' })).toBe(
      DEFAULT_RUN_CONFIG.sh.maxBackground,
    );
  });
});
