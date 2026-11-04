// 设置页抄了一份凭证能不能给容器的规矩（web/src/pages/settings/credentials.ts）：
// 和 Melina 保存设置时查的（src/core/config.ts credentialProblem，契约 469a4f3）对不上时这里会挂。

import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ENV_NAMES as CORE_ENV_NAMES,
  RESERVED_CREDENTIAL_DIRS as CORE_RESERVED,
  credentialProblem,
} from '../../../src/core/config.ts';
import {
  CREDENTIAL_ENV_NAMES,
  credentialIssue,
  RESERVED_CREDENTIAL_DIRS,
} from '../../../web/src/pages/settings/credentials.ts';

describe('设置页的凭证规矩和 Melina 的一样', () => {
  it('环境变量名单、不能放的目录', () => {
    expect([...CREDENTIAL_ENV_NAMES]).toEqual([...CORE_ENV_NAMES]);
    expect([...RESERVED_CREDENTIAL_DIRS]).toEqual([...CORE_RESERVED]);
  });

  it('同样的给法，两边都说行或都说不行', () => {
    const cases = [
      ...CORE_ENV_NAMES.map((env) => ({ env })),
      { env: 'SLACK_BOT_TOKEN' },
      { env: 'PATH' },
      { env: 'github_token' },
      { file: '/run/secrets/token' },
      { file: '/home/agent/.kube/config' },
      { file: '/' },
      { file: '/workspace' },
      { file: '/workspace/.env' },
      { file: '/workspace/../etc/token' },
      { file: '/melina/token' },
      { file: '/kingdom/token' },
      { file: '/run/melina/x' },
      { file: '/run//melina/x' },
      { file: '/run/./melina/x' },
      { file: '/run/kingly/x' },
      { file: 'relative/token' },
      { file: '/..' },
    ];
    for (const as of cases) {
      const core = credentialProblem({ name: 'x', as }) !== undefined;
      expect([as, credentialIssue(as) !== undefined]).toEqual([as, core]);
    }
  });
});
