import { afterEach, describe, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { Obj, Str } from '../../../src/core/schema.ts';
import { TOOL } from '../../../src/core/tools.ts';
import { extendTools } from '../../../src/tools/extensions.ts';
import { MelinaToolGateway } from '../../../src/tools/gateway.ts';
import { observe } from '../../../src/tools/observe.ts';
import type { ToolExtension } from '../../../src/tools/session.ts';
import { branch, call, type Kit, kit, openExplorer } from './gateway-kit.ts';

const kits: Kit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});

function setup(extension: ToolExtension) {
  const k = kit();
  kits.push(k);
  k.gateway = new MelinaToolGateway({
    writer: k.runStore.writer,
    queries: k.runStore.queries,
    artifacts: k.runStore.artifacts!,
    runtime: k.runtime,
    views: k.views,
    redactor: k.redactor,
    extensions: [extension],
  });
  return k;
}

function fixture(): ToolExtension {
  return {
    spec: {
      name: 'fixture_task',
      description: '可选的测试工具',
      parameters: Obj({ value: Str() }),
      environment: true,
      standalone: true,
    },
    roles: ['explorer'],
    run: (env, args) =>
      observe(env, {
        id: env.deps.newId(),
        tool: 'fixture_task',
        args: {},
        raw: (args as { value: string }).value,
        head: '扩展结果',
        startedAt: Date.now(),
      }),
  };
}

describe('可选工具扩展', () => {
  it('模型定义和执行顺序相同，扩展结果经过 Observation、脱敏与工具计数', async () => {
    const extension = fixture();
    const k = setup(extension);
    const b = await branch(k);
    const session = openExplorer(k, b);
    const assembler = new MelinaContextAssembler({
      queries: k.runStore.queries,
      tools: (layout) => extendTools(layout.tools, [extension], layout.role),
    });
    expect(assembler.forExplorer(b.branch).tools).toEqual(session.tools.map((tool) => tool.spec));
    const out = await call(session, 'fixture_task', { value: 'external result' });
    expect(out.isError, out.content).toBe(false);
    expect(k.runStore.queries.getObservation(out.observationId!)).toMatchObject({ tool: 'fixture_task' });
    expect(session.toolCalls).toBe(1);
    expect(
      session.check({ id: 'x', name: 'fixture_task', args: {} }, [{ id: 'x', name: 'fixture_task', args: {} }]),
    ).toBeUndefined();
    expect(
      session.check({ id: 'x', name: 'fixture_task', args: {} }, [
        { id: 'x', name: 'fixture_task', args: {} },
        { id: 'y', name: TOOL.read, args: {} },
      ]),
    ).toContain('必须单独调用');
  });

  it('角色和分支限制覆盖执行与原始输出检查', async () => {
    let inspected = false;
    const extension = fixture();
    extension.inspect = () => {
      inspected = true;
      return undefined;
    };
    const k = setup(extension);
    const session = k.gateway.open({ runId: k.run.id, role: 'scoper', snapshot: 'root', readOnly: true });
    expect(session.tools.some((tool) => tool.spec.name === 'fixture_task')).toBe(false);
    await call(session, TOOL.sh, { cmd: 'printf visible' });
    expect(inspected).toBe(false);
    expect((await call(session, 'fixture_task', { value: 'x' })).isError).toBe(true);
  });

  it('原始输出检查在落盘前发生，存档后的钩子拿到真实 Observation', async () => {
    const extension = fixture();
    let saved: string | undefined;
    extension.inspect = () => ({
      inspect: (text) => text.replaceAll('private-fixture-value', '[private]'),
      finish: async (outcome) => {
        saved = outcome.observationId;
        return outcome;
      },
    });
    const k = setup(extension);
    const b = await branch(k);
    const session = openExplorer(k, b);
    const out = await call(session, TOOL.sh, { cmd: 'printf private-fixture-value' });
    expect(out.isError, out.content).toBe(false);
    expect(out.content).not.toContain('private-fixture-value');
    expect(saved).toBe(out.observationId);
    const observation = k.runStore.queries.getObservation(saved!)!;
    const lines = await k.runStore.artifacts!.readLines(k.run.id, observation.output);
    expect(JSON.stringify(lines)).not.toContain('private-fixture-value');
  });

  it('拒绝覆盖内置工具和重复注册，默认工具集不依赖扩展仓库', () => {
    expect(() => setup({ ...fixture(), spec: { ...fixture().spec, name: TOOL.sh } })).toThrow('重复');
    const k = kit();
    kits.push(k);
    expect(
      () =>
        new MelinaToolGateway({
          writer: k.runStore.writer,
          queries: k.runStore.queries,
          artifacts: k.runStore.artifacts!,
          runtime: k.runtime,
          views: k.views,
          redactor: k.redactor,
          extensions: [fixture(), fixture()],
        }),
    ).toThrow('重复');
  });
});
