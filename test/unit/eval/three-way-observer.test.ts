import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, ROOT } from '../../../src/core/ids.ts';
import type { RoleCallRequest, RoleCallResult } from '../../../src/core/interfaces/agents.ts';
import { heimdallObserver, replaceMap } from '../../eval/three-way/observer.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'melina-three-way-test-'));
  dirs.push(dir);
  const requests: RoleCallRequest[] = [];
  const resolves: ((result: RoleCallResult) => void)[] = [];
  const runId = newId();
  const branchId = newId();
  const observer = heimdallObserver({
    runner: {
      start(req) {
        requests.push(req);
        const done = new Promise<RoleCallResult>((resolve) => resolves.push(resolve));
        return { done, steer() {} };
      },
    },
    meta: {
      runId,
      branchId,
      role: 'watcher',
      job: 'watcher_call',
      sessionId: branchId,
      model: { provider: 'fake', model: 'test', tier: 'strong' },
    },
    goal: '调查未知格式并交付结果',
    dir,
    caller: { runId, branchId, role: 'explorer', episode: 1, snapshot: ROOT, readOnly: false },
    redactor: { redact: (text) => text.replace(/secret-value/g, '[hidden]') },
  });
  const observe = (n: number) => {
    for (let i = 0; i < n; i++)
      observer.observe(
        { id: String(i), name: 'sh', args: { cmd: 'inspect secret-value' } },
        { content: 'result secret-value', isError: false },
      );
  };
  const finish = (i: number) =>
    resolves[i]!({
      outcome: { kind: 'no_close' },
      toolCalls: 0,
      turns: 1,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 },
    });
  const submit = async (i: number, args: unknown) =>
    requests[i]!.session.tools[1]!.run(
      { id: 'submit', name: 'submit_observation', args },
      new AbortController().signal,
    );
  return { observer, requests, observe, finish, submit, dir };
}

function update(baseRevision: string | null, turn: number, attempt: string) {
  return {
    baseRevision,
    upserts: [
      {
        id: 'format',
        subject: '候选文件格式',
        status: 'tried-miss',
        conclusion: '该样本上的候选解释未成立',
        basis: '真实工具输出',
        uncertainty: '只试了一个样本',
        evidenceRefs: [`turn:${turn}`],
        attempts: [{ id: attempt, action: '检查样本', result: '样本不匹配', evidenceRefs: [`turn:${turn}`] }],
      },
    ],
    retireIds: [],
    guidance: { hypothesis: null, lock: null, confirmedIds: ['format'], angleIds: [], tension: [] },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Heimdall 式评测观察者', () => {
  it('冻结窗口、只读展开、遮凭证；在主会话继续干活时不提前看到后续记录', async () => {
    const h = harness();
    h.observe(9);
    expect(h.requests).toHaveLength(0);
    h.observe(1);
    expect(h.requests).toHaveLength(1);
    h.observe(1);
    const req = h.requests[0]!;
    expect(req.layout.messages[0]!.text).not.toContain('secret-value');
    const read = await req.session.tools[0]!.run(
      { id: 'read', name: 'observation_context', args: { evidenceRefs: ['turn:10', 'turn:11'] } },
      new AbortController().signal,
    );
    const content = JSON.parse(read.content);
    expect(content.evidence['turn:10']).not.toBeNull();
    expect(content.evidence['turn:11']).toBeNull();
    expect(await h.submit(0, update(null, 1, 'attempt1'))).toMatchObject({ isError: false, terminate: true });
    h.finish(0);
    await tick();
    expect(h.observer.system('original')).toContain('该样本上的候选解释未成立');
    await h.observer.close();
  });

  it('新观察者会话仅靠持久图和增量；合并保留旧尝试历史', async () => {
    const h = harness();
    h.observe(10);
    await h.submit(0, update(null, 1, 'attempt1'));
    h.finish(0);
    await tick();
    h.observe(10);
    expect(h.requests).toHaveLength(2);
    const input = JSON.parse(h.requests[1]!.layout.messages[0]!.text);
    expect(input.incremental).toHaveLength(10);
    expect(input.incremental[0].ref).toBe('turn:11');
    expect(input.previous.assessments[0].attempts[0].id).toBe('attempt1');
    expect(await h.submit(1, update(input.previous.revision, 20, 'attempt2'))).toMatchObject({ isError: false });
    h.finish(1);
    await tick();
    await h.observer.close();
    const saved = JSON.parse(readFileSync(join(h.dir, 'observer/final.json'), 'utf8'));
    expect(saved.assessments[0].attempts.map((a: { id: string }) => a.id)).toEqual(['attempt1', 'attempt2']);
  });

  it('拒绝窗口之外的执行证据，不发布模型草稿', async () => {
    const h = harness();
    h.observe(10);
    expect(await h.submit(0, update(null, 11, 'attempt1'))).toMatchObject({ isError: true });
    expect(h.observer.system('original')).toBe('original');
    h.finish(0);
    await tick();
    await h.observer.close();
  });

  it('主会话结束后拒绝迟到的发布', async () => {
    const h = harness();
    h.observe(10);
    const closing = h.observer.close();
    expect(await h.submit(0, update(null, 1, 'attempt1'))).toMatchObject({ isError: true });
    h.finish(0);
    await closing;
    expect(h.observer.system('original')).toBe('original');
  });

  it('请求前地图替换清掉旧版，原始会话前缀保持不变', () => {
    const old = 'rules\n\n<heimdall-map>old</heimdall-map>\n';
    const current = replaceMap(old, '<heimdall-map>new</heimdall-map>');
    expect(current).toBe('rules\n\n<heimdall-map>new</heimdall-map>');
    expect(replaceMap(current, '<heimdall-map>v3</heimdall-map>')).not.toContain('new');
  });
});
