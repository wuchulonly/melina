// Melina SDK 能直接给跑分脚本用：进程内的 Melina 当 MelinaClient、它的 MelinaRun 当跑分脚本的 MelinaRun。
// 只查类型（下面两个函数能编译就行，pnpm typecheck 时查）；真跑要运行时和容器，留给联调。

import { describe, expect, it } from 'vitest';
import type { Melina, MelinaRun as SdkRun } from '../../../src/api/sdk.ts';
import type { MelinaClient, MelinaRun } from '../../eval/melina.ts';

const asClient = (melina: Melina): MelinaClient => melina;
const asRun = (run: SdkRun): MelinaRun => run;

describe('SDK 和跑分脚本的接口', () => {
  it('SDK 的 Melina 可以当 MelinaClient 传给 melinaContender', () => {
    expect(typeof asClient).toBe('function');
    expect(typeof asRun).toBe('function');
  });
});
