// 跑分这边要用的容器：单 agent 基线在里面干活，代码题的交付在里面跑隐藏测试。
// 要和被测的 Melina 用同一种：装了 Podman 的机器是 Podman；
// 这台开发机起不了 Podman，用 test/dev 的 proot，Melina 也要用 test/dev/serve.ts 起。

import type { ContainerRuntime } from '../../src/core/interfaces/container.ts';
import { detectEngine, PodmanRuntime } from '../../src/tools/container.ts';
import { DomainImages } from '../../src/tools/container-images.ts';
import { SecretRedactor } from '../../src/tools/redact.ts';
import { ProotRuntime } from '../dev/proot-runtime.ts';

export type RuntimeKind = 'podman' | 'proot';

export interface EvalRuntimeOptions {
  /** proot 的「容器」放哪（一次评估一个目录） */
  root: string;
  /** 落盘和返回之前换掉的值（key 文件里的 key） */
  secrets: readonly string[];
  /** proot：只许连这些 TCP 端口（Landlock）；和 Melina 那边的 --net-allow 给一样的 */
  netAllow?: readonly number[];
  log?: (text: string) => void;
}

export function secretRedactor(secrets: readonly string[]): SecretRedactor {
  const redactor = new SecretRedactor();
  // 只拿来换值：id、as 这两项 redactor 不看
  redactor.update(
    secrets.map((value, i) => ({ id: `key-${i + 1}`, name: `KEY_${i + 1}`, as: { env: 'UNUSED' }, value })),
  );
  return redactor;
}

export function evalRuntime(kind: RuntimeKind, options: EvalRuntimeOptions): ContainerRuntime {
  const redactor = secretRedactor(options.secrets);
  if (kind === 'proot') {
    return new ProotRuntime({
      root: options.root,
      redactor,
      ...(options.netAllow?.length ? { netAllow: options.netAllow } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  }
  const engine = detectEngine();
  if (!engine)
    throw new Error(
      '找不到 Podman 或 Docker：在起不了容器的开发机上加 --runtime proot（Melina 也用 test/dev/serve.ts 起）',
    );
  return new PodmanRuntime({
    engine,
    images: new DomainImages(),
    redactor,
    ...(options.log ? { onWarn: options.log } : {}),
  });
}
