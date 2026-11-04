import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../../../src/core/events.ts';
import { checkEvent, eventIssues } from '../../../src/core/validate.ts';

const RUN = '01K6G6T0E0Q9V7Y8Z1A2B3C4D5';
const event = (type: string, data: unknown, runId: string | null = RUN) => ({
  seq: 1,
  runId,
  type,
  at: '2026-10-01T09:00:00Z',
  data,
});
describe('运行事件', () => {
  it('事件集只保留任务、执行、交付、观察者和用量', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'run.created',
        'run.updated',
        'run.recovered',
        'completion.drafted',
        'bet.created',
        'bet.updated',
        'branch.created',
        'branch.updated',
        'episode.closed',
        'snapshot.created',
        'observation.created',
        'candidate.created',
        'inbox.created',
        'input.created',
        'sh.intent',
        'version.picked',
        'watch.noted',
        'usage.updated',
        'system.updated',
      ].sort(),
    );
  });
  it('按 type 校验 data，拒绝已删除的黑板事件', () => {
    expect(checkEvent(event('run.recovered', { branches: [], unknownCommands: [], rescoped: false })).type).toBe(
      'run.recovered',
    );
    expect(eventIssues(event('run.recovered', { branches: 'bad' })).length).toBeGreaterThan(0);
    for (const type of ['fact.created', 'report.created', 'decision.created', 'rule.fired', 'ask.created'])
      expect(eventIssues(event(type, {})).length).toBeGreaterThan(0);
  });
  it('系统事件只在全局流中，运行事件必须属于具体任务', () => {
    const status = {
      providers: [],
      toolExec: { limit: 8, running: 0, queued: 0, auto: true },
      disk: { freeBytes: 1, minBytes: 0, ok: true },
      runs: { running: 0, paused: 0 },
    };
    expect(eventIssues(event('system.updated', status, null))).toEqual([]);
    expect(eventIssues(event('system.updated', status)).length).toBeGreaterThan(0);
    expect(
      eventIssues(event('run.recovered', { branches: [], unknownCommands: [], rescoped: false }, null)).length,
    ).toBeGreaterThan(0);
  });
});
