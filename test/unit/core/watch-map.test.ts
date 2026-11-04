import { describe, expect, it } from 'vitest';
import type { WatchDirection } from '../../../src/core/types.ts';
import { bruteLaterScore, projectWatchMap } from '../../../src/core/watch-map.ts';

const angle = (id: string, direction: string, priority?: number): WatchDirection => ({
  id,
  direction,
  status: 'untried',
  result: '已有线索',
  evidence: [],
  attempts: [],
  ...(priority ? { priority } : {}),
});

describe('旁观地图的逻辑方向优先排序', () => {
  it.each([undefined, 1])('爆破优先级为 %s 时逻辑方向仍排在前面，排序不修改历史', (priority) => {
    const directions = [
      angle('brute', 'hydra 密码爆破', priority),
      angle('auth', '鉴权逻辑验证'),
      angle('sqli', 'SQLi 登录绕过'),
      angle('lfi', '文件包含验证'),
      angle('logic', '业务流程检查'),
    ];
    const original = structuredClone(directions);
    expect(projectWatchMap({ directions }).angles.map((d) => d.id)).toEqual(['auth', 'sqli', 'lfi', 'logic']);
    expect(directions).toEqual(original);
  });

  it('同类内保留模型优先级，未指定优先级时顺序稳定；退休方向不入图', () => {
    const directions = [
      angle('brute', 'hashcat 密钥破解', 1),
      angle('auth', '鉴权逻辑', 3),
      angle('sqli', 'SQLi 验证', 1),
      angle('flow', '流程验证', 1),
      { ...angle('retired', '废弃入口', 1), retired: true },
    ];
    expect(projectWatchMap({ directions }).angles.map((d) => d.id)).toEqual(['sqli', 'flow', 'auth', 'brute']);
  });

  it.each([
    ['SQLi 登录注入小字典', 0],
    ['wordlists/lfi.txt 定向验证', 0],
    ['使用已收集的口令规则生成有限候选', 0],
    ['spray_creds.txt 定向喷洒', 0],
    ['JWT secret 字典爆破', 1],
    ['rockyou password dictionary', 1],
    ['john hash cracking', 1],
    ['hydra 弱口令', 1],
    ['ffuf dirbust', 1],
  ])('%s 的后置评分为 %s', (text, score) => {
    expect(bruteLaterScore(text)).toBe(score);
  });
});
