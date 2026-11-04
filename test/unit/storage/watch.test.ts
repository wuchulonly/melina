import { afterEach, describe, expect, it } from 'vitest';
import { handleOf, newId } from '../../../src/core/ids.ts';
import type { WatchInput } from '../../../src/core/interfaces/store.ts';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import type { WatchBody } from '../../../src/core/types.ts';
import { projectWatchMap } from '../../../src/core/watch-map.ts';
import {
  allWatchAttempts,
  latestWatch,
  mergeWatch,
  WATCH_MAX_ATTEMPTS,
  watchEvidence,
  watchIssues,
  watchVersions,
} from '../../../src/projections/watch.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

const runStores: TestRunStore[] = [];
function runStore(): TestRunStore {
  const b = testRunStore();
  runStores.push(b);
  return b;
}
afterEach(() => {
  for (const b of runStores.splice(0)) b.close();
});
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (
      (
        error as {
          code?: string;
        }
      ).code ?? 'thrown'
    );
  }
  return undefined;
}
const WATCHER = { provider: 'zhipu', model: 'glm-5.3', tier: 'strong' as const };
type DraftDirection = SubmitWatchArgs['directions'][number];
type DraftAttempt = DraftDirection['attempts'][number];
function draft(over: Partial<SubmitWatchArgs> = {}): SubmitWatchArgs {
  return {
    standing: '第 1 条完成标准还没有观测证明',
    directions: [],
    tension: [],
    advice: '先把测试跑起来',
    ...over,
  };
}
/** 草稿里的一个方向：默认在试、带一次尝试（除了 untried 都要有尝试） */
function dir(over: Partial<DraftDirection> & Pick<DraftDirection, 'id' | 'direction'>): DraftDirection {
  return { status: 'trying', result: '在试', evidence: [], attempts: [tried('t1')], ...over };
}
function tried(id: string, action = `试一次（${id}）`, evidence: string[] = []): DraftAttempt {
  return { id, action, result: '有结果', evidence };
}
describe('合并（mergeWatch）', () => {
  it('禁扫标记每版整份重写：空或省略撤销，方向历史仍保留，旧版不变', () => {
    const v1 = mergeWatch(
      undefined,
      draft({
        forbid: [' dirbust ', 'dirbust', ''],
        directions: [
          dir({
            id: 'paths',
            direction: '探查路径',
          }),
        ],
      }),
    );
    const cleared = mergeWatch(v1, draft({ forbid: [] }));
    const omitted = mergeWatch(v1, draft());
    expect(v1.forbid).toEqual(['dirbust']);
    expect(cleared.forbid).toEqual([]);
    expect(omitted.forbid).toBeUndefined();
    expect(cleared.directions).toEqual(v1.directions);
    expect(omitted.directions).toEqual(v1.directions);
    expect(mergeWatch(v1, draft({ forbid: ['portscan'] })).forbid).toEqual(['portscan']);
  });
  it('第一版：编号照巡检器起的；证据去重，空的 doubt 不留；确定了的、值得试的照引到的方向编好句子', () => {
    const body = mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'cache',
            direction: '加缓存',
            status: 'works',
            result: '降到 0.8 秒',
            evidence: ['a', 'a', 'b'],
            doubt: '  ',
            attempts: [
              { id: 't1', action: '缓存整页', result: '命中率 10%', evidence: ['o1', 'o1'] },
              { id: 't2', action: '缓存汇率', result: '命中率 90%', evidence: [] },
            ],
          }),
          dir({
            id: 'parallel',
            direction: '并行请求',
            status: 'untried',
            result: '还没试',
            attempts: [],
          }),
        ],
        tension: ['日志说 3 秒', '计时说 12 秒'],
      }),
    );
    expect(body.directions.map((d) => [d.id, d.direction, d.evidence])).toEqual([
      ['cache', '加缓存', ['a', 'b']],
      ['parallel', '并行请求', []],
    ]);
    expect(body.directions[0]).not.toHaveProperty('doubt');
    expect(body.directions[0]?.attempts).toEqual([
      { id: 't1', action: '缓存整页', result: '命中率 10%', evidence: ['o1'] },
      { id: 't2', action: '缓存汇率', result: '命中率 90%', evidence: [] },
    ]);
    expect(
      projectWatchMap(body).confirmed.map((d) => ({ statement: `${d.direction}：${d.result}`, evidence: [] })),
    ).toEqual([{ statement: '加缓存：降到 0.8 秒', evidence: [] }]);
    expect(projectWatchMap(body).angles.map((d) => d.direction)).toEqual(['并行请求']);
    expect(body.tension.map((statement) => ({ statement, evidence: [] }))).toEqual([
      { statement: '日志说 3 秒', evidence: [] },
      { statement: '计时说 12 秒', evidence: [] },
    ]);
    expect([projectWatchMap(body).confirmed.map((d) => d.id), projectWatchMap(body).angles.map((d) => d.id)]).toEqual([
      ['cache'],
      ['parallel'],
    ]);
  });
  it('写了上一版已有编号的整项换掉；没写到的照留；新编号接在后面', () => {
    const v1: WatchBody = mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'cache',
            direction: '加缓存',
            doubt: '命中率不知道',
          }),
          dir({
            id: 'algo',
            direction: '换算法',
            result: '写了一半',
          }),
        ],
      }),
    );
    const v2 = mergeWatch(
      v1,
      draft({
        standing: '缓存走通了',
        directions: [
          dir({
            id: 'cache',
            direction: '加缓存',
            status: 'works',
            result: '降到 0.8 秒',
            evidence: ['o1'],
          }),
          dir({
            id: 'timeout',
            direction: '调超时',
            status: 'failed',
            result: '超时 1 秒时接口报错',
          }),
        ],
      }),
    );
    expect(v2.standing).toBe('缓存走通了');
    expect(v2.directions.map((d) => [d.id, d.status, d.result])).toEqual([
      ['cache', 'works', '降到 0.8 秒'],
      ['algo', 'trying', '写了一半'],
      ['timeout', 'failed', '超时 1 秒时接口报错'],
    ]);
    // 整项换掉：上一版的 doubt 不会留下来
    expect(v2.directions[0]).not.toHaveProperty('doubt');
    // 上一版不被改动
    expect(v1.directions[0]?.status).toBe('trying');
  });
  it('尝试按编号合并：同编号的换掉、新编号的接在后面，老的照留；这一轮没写尝试的照留', () => {
    const v1 = mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'tests',
            direction: '补测试',
            attempts: [tried('t1', '补分页的测试', ['o1'])],
          }),
        ],
      }),
    );
    const v2 = mergeWatch(
      v1,
      draft({
        directions: [
          dir({
            id: 'tests',
            direction: '补测试',
            result: '分页修好了',
            attempts: [tried('t2', '改分页的边界', ['o2']), tried('t1', '补分页的测试（重跑）', ['o3'])],
          }),
        ],
      }),
    );
    expect(v2.directions[0]?.attempts.map((a) => [a.id, a.action])).toEqual([
      ['t1', '补分页的测试（重跑）'],
      ['t2', '改分页的边界'],
    ]);
    const v3 = mergeWatch(
      v2,
      draft({
        directions: [
          dir({
            id: 'tests',
            direction: '补测试',
            status: 'works',
            attempts: [],
          }),
        ],
      }),
    );
    expect(v3.directions[0]?.attempts).toHaveLength(2);
    expect(v1.directions[0]?.attempts).toHaveLength(1);
  });
  it('退休保留历史，更新不隐式恢复，retired:false 显式恢复', () => {
    const v1 = mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'a',
            direction: '甲',
          }),
          dir({
            id: 'b',
            direction: '乙',
          }),
        ],
      }),
    );
    const v2 = mergeWatch(v1, draft({ directions: [{ ...v1.directions[0]!, attempts: [], retired: true }] }));
    expect(v2.directions.map((d) => [d.id, d.retired ?? false])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    const v3 = mergeWatch(v2, draft({}));
    expect(v3.directions[0]?.retired).toBe(true);
    const v4 = mergeWatch(
      v3,
      draft({
        directions: [
          dir({
            id: 'a',
            direction: '甲',
            attempts: [tried('t2', '换个条件试甲')],
            retired: false,
          }),
        ],
      }),
    );
    expect(v4.directions[0]?.retired).toBe(false);
    expect(v4.directions[0]?.attempts.map((a) => a.id)).toEqual(['t1', 't2']);
  });
  it('模型把显示时的标签也写进了正文：去掉，不然显示成两遍', () => {
    const body = mergeWatch(undefined, draft({ standing: '现在到哪了：还差第 1 条', advice: ' 最该注意: 先跑测试' }));
    expect(body.standing).toBe('还差第 1 条');
    expect(body.advice).toBe('先跑测试');
  });
  it('引用的证据：方向和它的尝试，去重按出现的先后', () => {
    const body = mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'cache',
            direction: '加缓存',
            status: 'works',
            evidence: ['b', 'a'],
            attempts: [tried('t1', '缓存汇率', ['e', 'a'])],
          }),
        ],
      }),
    );
    expect(watchEvidence(body)).toEqual(['b', 'a', 'e']);
  });
});
describe('不合格整份退回（watchIssues）', () => {
  const v1 = () =>
    mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'base',
            direction: '量基线',
            status: 'works',
          }),
          dir({
            id: 'idea',
            direction: '并行',
            status: 'untried',
            attempts: [],
          }),
          dir({
            id: 'old',
            direction: '老做法',
          }),
        ],
      }),
    );
  it('合格的是空数组', () => {
    expect(watchIssues(undefined, draft())).toEqual([]);
    expect(watchIssues(v1(), draft({}))).toEqual([]);
  });
  it('同轮更新并退休只通过方向属性表达', () => {
    const previous = v1();
    const update = draft({ directions: [{ ...previous.directions[2]!, attempts: [], retired: true }] });
    expect(watchIssues(previous, update)).toEqual([]);
    expect(mergeWatch(previous, update).directions[2]?.retired).toBe(true);
  });
  it('编号重了：方向写了两次、同一个方向里尝试写了两次', () => {
    const issues = watchIssues(
      undefined,
      draft({
        directions: [
          dir({
            id: 'a',
            direction: '甲',
            attempts: [tried('t1'), tried('t1')],
          }),
          dir({
            id: 'a',
            direction: '甲又一次',
          }),
        ],
      }),
    );
    expect(issues).toContain('方向 a 在 directions 里写了两次');
    expect(issues).toContain('方向 a 的尝试 t1 写了两次');
  });
  it('明确已试状态要有尝试；untried 和 unclear 可以没有', () => {
    expect(
      watchIssues(
        undefined,
        draft({
          directions: [
            dir({
              id: 'a',
              direction: '甲',
              attempts: [],
            }),
          ],
        }),
      ),
    ).toEqual([expect.stringContaining('方向 a 的状态是 trying，要至少一次尝试')]);
    expect(
      watchIssues(
        undefined,
        draft({
          directions: [
            dir({
              id: 'a',
              direction: '甲',
              status: 'untried',
              attempts: [],
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });
  it(`一个方向保留最近 ${WATCH_MAX_ATTEMPTS} 次尝试，更多自动归档且完整可查`, () => {
    let body = mergeWatch(
      undefined,
      draft({
        directions: [
          dir({
            id: 'a',
            direction: '甲',
          }),
        ],
      }),
    );
    for (let i = 2; i <= WATCH_MAX_ATTEMPTS; i++) {
      body = mergeWatch(
        body,
        draft({
          directions: [
            dir({
              id: 'a',
              direction: '甲',
              attempts: [tried(`t${i}`)],
            }),
          ],
        }),
      );
    }
    expect(body.directions[0]?.attempts).toHaveLength(WATCH_MAX_ATTEMPTS);
    const more = draft({
      directions: [
        dir({
          id: 'a',
          direction: '甲',
          attempts: [tried('t99')],
        }),
      ],
    });
    expect(watchIssues(body, more)).toEqual([]);
    const rolled = mergeWatch(body, more);
    expect(rolled.directions[0]!.attempts).toHaveLength(WATCH_MAX_ATTEMPTS);
    expect(rolled.directions[0]!.archivedAttempts?.[0]?.id).toBe('t1');
    const archived = mergeWatch(body, { ...more, directions: more.directions.map((d) => ({ ...d, retired: true })) });
    expect(archived.directions[0]).toMatchObject({ retired: true, result: more.directions[0]!.result });
    expect(allWatchAttempts(archived.directions[0]!)).toHaveLength(WATCH_MAX_ATTEMPTS + 1);
    expect(body.directions[0]!.attempts).toHaveLength(WATCH_MAX_ATTEMPTS);
    expect(
      watchIssues(
        undefined,
        draft({
          directions: [
            dir({
              id: 'new',
              direction: '当轮完成',
            }),
          ],
        }),
      ),
    ).toEqual([]);
    // 退休、另起一个方向：收
    expect(
      watchIssues(
        body,
        draft({
          directions: [
            dir({
              id: 'a2',
              direction: '甲（第二段）',
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });
  it('当轮归档不能绕过新方向至少一次尝试的结构约束', () => {
    expect(
      watchIssues(
        undefined,
        draft({
          directions: [
            dir({
              id: 'new',
              direction: '没有执行过',
              attempts: [],
            }),
          ],
        }),
      ),
    ).toEqual([expect.stringContaining('方向 new 的状态是 trying，要至少一次尝试')]);
  });
  it('投影自动展示活跃已试方向与明确未试备选，退休方向不展示', () => {
    const body = v1();
    body.directions[2]!.retired = true;
    expect(projectWatchMap(body)).toEqual({ confirmed: [body.directions[0]], angles: [body.directions[1]] });
  });
  it('对不上的要么没有、要么正好两句', () => {
    expect(watchIssues(undefined, draft({ tension: ['只有一句'] }))).toEqual([
      'tension 要么给空数组，要么正好两句互相矛盾的原话',
    ]);
    expect(watchIssues(undefined, draft({ tension: ['甲说 1', '乙说 2'] }))).toEqual([]);
  });
});
function setup() {
  const b = runStore();
  const run = newRun(b);
  const bet0 = startBranch(b, run, { kind: 'direct', label: '主干直解路线' }).branch;
  const other = startBranch(b, run, { label: '换个算法' }).branch;
  return { b, run, bet0, other };
}
function input(over: Partial<WatchInput> & Pick<WatchInput, 'runId' | 'branchId'>, b: TestRunStore): WatchInput {
  return { basedOnSeq: b.queries.lastSeq(), toolCalls: 10, model: WATCHER, draft: draft(), ...over };
}
describe('写一版（RunStoreWriter.recordWatch）', () => {
  it('禁扫标记随 watch.noted 持久化，读取历史和分支下钻均以对应版本为准', () => {
    const { b, run, bet0 } = setup();
    const first = b.writer.recordWatch(
      input({ runId: run.id, branchId: bet0.id, draft: draft({ forbid: ['dirbust'] }) }, b),
    );
    const at = b.queries.lastSeq();
    expect(latestWatch(b.queries, run.id, bet0.id)?.forbid).toEqual(['dirbust']);
    expect(b.queries.branchDetail(run.id, bet0.id)?.watch?.forbid).toEqual(['dirbust']);
    b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, draft: draft({ forbid: [] }) }, b));
    expect(latestWatch(b.queries, run.id, bet0.id)?.forbid).toEqual([]);
    expect(b.queries.branchDetail(run.id, bet0.id)?.watch?.forbid).toEqual([]);
    expect(latestWatch(b.queries, run.id, bet0.id, at)?.forbid).toEqual(first.forbid);
  });
  it('和上一版合并、rev 加 1，发 watch.noted；按分支读出各版', () => {
    const { b, run, bet0 } = setup();
    const o = observe(b, bet0, '覆盖率 61%');
    const first = b.writer.recordWatch(
      input(
        {
          runId: run.id,
          branchId: bet0.id,
          draft: draft({
            directions: [
              dir({
                id: 'tests',
                direction: '补测试',
                result: '61%',
                evidence: [o.id],
                attempts: [tried('t1', '跑覆盖率', [o.id])],
              }),
            ],
          }),
        },
        b,
      ),
    );
    expect(first).toMatchObject({ branchId: bet0.id, rev: 1, toolCalls: 10, model: WATCHER });
    expect(b.published.at(-1)).toMatchObject({ type: 'watch.noted', data: first });
    const firstSeq = b.published.at(-1)?.seq as number;
    const o2 = observe(b, bet0, '覆盖率 83%');
    const second = b.writer.recordWatch(
      input(
        {
          runId: run.id,
          branchId: bet0.id,
          toolCalls: 20,
          draft: draft({
            directions: [
              dir({
                id: 'tests',
                direction: '补测试',
                status: 'works',
                result: '83%',
                evidence: [o2.id],
                attempts: [tried('t2', '补 3 条测试再跑', [o2.id])],
              }),
            ],
          }),
        },
        b,
      ),
    );
    expect(second.rev).toBe(2);
    expect(second.directions[0]?.attempts.map((a) => [a.id, a.evidence])).toEqual([
      ['t1', [o.id]],
      ['t2', [o2.id]],
    ]);
    expect(
      projectWatchMap(second).confirmed.map((d) => ({ statement: `${d.direction}：${d.result}`, evidence: [] })),
    ).toEqual([{ statement: '补测试：83%', evidence: [] }]);
    expect(watchVersions(b.queries, run.id, bet0.id).map((v) => v.rev)).toEqual([1, 2]);
    expect(latestWatch(b.queries, run.id, bet0.id)?.rev).toBe(2);
    // 给了 untilSeq 就只要那一刻以前写上的
    expect(latestWatch(b.queries, run.id, bet0.id, firstSeq)).toMatchObject({ rev: 1, seq: firstSeq });
    expect(latestWatch(b.queries, run.id, bet0.id, firstSeq - 1)).toBeUndefined();
  });
  it('草稿不合格写不进去（兜底：巡检器交的时候已经核对过）', () => {
    const { b, run, bet0 } = setup();
    const bad = draft({ tension: ['只有一句'] });
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, draft: bad }, b)))).toBe(
      'invalid',
    );
    expect(watchVersions(b.queries, run.id, bet0.id)).toEqual([]);
  });
  it('每条 direct 路线都能发布；拒绝引用其他任务的分支', () => {
    const { b, run, other } = setup();
    expect(b.writer.recordWatch(input({ runId: run.id, branchId: other.id }, b)).branchId).toBe(other.id);
    const run2 = newRun(b);
    const bet0of2 = startBranch(b, run2, { kind: 'direct', label: '主干直解路线' }).branch;
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0of2.id }, b)))).toBe('invalid');
  });
  it('主干直解路线开了几份：每份各有各的看法、各数各的版本；一份的记录当不了另一份的依据', () => {
    const { b, run, bet0 } = setup();
    const copy = startBranch(b, run, { kind: 'direct', label: '主干直解路线（b）' }).branch;
    const theirs = observe(b, copy, '这一份跑的');
    const cites = draft({
      directions: [
        dir({
          id: 'run',
          direction: '跑一遍',
          evidence: [theirs.id],
          attempts: [tried('t1', '跑一遍', [theirs.id])],
        }),
      ],
    });
    b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id }, b));
    b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id }, b));
    expect(b.writer.recordWatch(input({ runId: run.id, branchId: copy.id, draft: cites }, b))).toMatchObject({
      branchId: copy.id,
      rev: 1,
    });
    expect(latestWatch(b.queries, run.id, bet0.id)?.rev).toBe(2);
    // 几份互相隔开：这一份跑的，另一份的巡检器看不到
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, draft: cites }, b)))).toBe(
      'invalid',
    );
  });
  it('basedOnSeq 不能比上一版早，也不能比现在最新的 seq 晚', () => {
    const { b, run, bet0 } = setup();
    const at = b.queries.lastSeq();
    b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, basedOnSeq: at }, b));
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, basedOnSeq: at - 1 }, b)))).toBe(
      'invalid',
    );
    const future = b.queries.lastSeq() + 1;
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, basedOnSeq: future }, b)))).toBe(
      'invalid',
    );
    // 同一刻看了两轮（没有新记录）也收
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, basedOnSeq: at }, b)))).toBe(
      undefined,
    );
  });
  it('证据要是这条路线看得到的记录：别的路线的、别的任务的、不存在的都不收，写在尝试里的也一样', () => {
    const { b, run, bet0, other } = setup();
    const theirs = observe(b, other, '别的路线跑的');
    const run2 = newRun(b);
    const elsewhere = observe(b, startBranch(b, run2, { kind: 'direct', label: '主干直解路线' }).branch);
    for (const id of [theirs.id, elsewhere.id, newId()]) {
      const bad = draft({
        directions: [
          dir({
            id: 'tests',
            direction: '补测试',
            evidence: [id],
          }),
        ],
      });
      expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, draft: bad }, b)))).toBe(
        'invalid',
      );
    }
    const inAttempt = draft({
      directions: [
        dir({
          id: 'tests',
          direction: '补测试',
          attempts: [tried('t1', '跑测试', [theirs.id])],
        }),
      ],
    });
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id, draft: inAttempt }, b)))).toBe(
      'invalid',
    );
    expect(watchVersions(b.queries, run.id, bet0.id)).toEqual([]);
  });
  it('直接写入也校验实际尝试，空依据和窗口之后的执行都不能发布', () => {
    const { b, run, bet0 } = setup();
    const until = b.queries.lastSeq();
    const later = observe(b, bet0, '截止点以后才执行');
    for (const evidence of [[], [later.id]]) {
      expect(() =>
        b.writer.recordWatch(
          input(
            {
              runId: run.id,
              branchId: bet0.id,
              basedOnSeq: until,
              draft: draft({
                directions: [
                  dir({
                    id: 'tests',
                    direction: '跑测试',
                    attempts: [tried('t1', '执行', evidence)],
                  }),
                ],
              }),
            },
            b,
          ),
        ),
      ).toThrow(evidence.length ? '已覆盖窗口之后' : '尝试 t1 缺少执行依据');
    }
    expect(watchVersions(b.queries, run.id, bet0.id)).toEqual([]);
  });
  it('任务在收尾、已经结束，或者这条路线已经结束以后不收（迟到写入，没人读了）', () => {
    const settling = setup();
    settling.b.writer.updateRun(settling.run.id, { mode: 'settling' });
    expect(
      code(() =>
        settling.b.writer.recordWatch(input({ runId: settling.run.id, branchId: settling.bet0.id }, settling.b)),
      ),
    ).toBe('conflict');
    const { b, run, bet0 } = setup();
    b.writer.endRun(run.id, {
      status: 'cancelled',
      endReason: '你取消了任务',
      result: { knowledgeReport: handleOf('#') },
      branchNote: '你取消了任务',
    });
    expect(code(() => b.writer.recordWatch(input({ runId: run.id, branchId: bet0.id }, b)))).toBe('conflict');
    const other = setup();
    other.b.writer.updateBranch(other.bet0.id, { state: 'failed', stateNote: '连续几段没收好尾' });
    expect(
      code(() => other.b.writer.recordWatch(input({ runId: other.run.id, branchId: other.bet0.id }, other.b))),
    ).toBe('conflict');
  });
});
