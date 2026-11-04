import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import ctfExtension from '../../../extensions/ctf/entry.ts';
import { melinaRuntime } from '../../../src/api/runtime.ts';
import { type InfraDeps, Melina } from '../../../src/api/sdk.ts';
import { DEFAULT_RUN_CONFIG } from '../../../src/core/config.ts';
import { newId } from '../../../src/core/ids.ts';
import type { ContextAssembler } from '../../../src/core/interfaces/context.ts';
import type { RuntimeKernel } from '../../../src/runtime/runtime.ts';

it('CTF 策略跟随当前领域，完整正文去重并更新旧条款', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melina-ctf-prompts-'));
  const policy = readFileSync(new URL('../../../extensions/ctf/execution-policy.md', import.meta.url), 'utf8').trim();
  const tsecPolicy = readFileSync(new URL('../../../extensions/ctf/tsec-policy.md', import.meta.url), 'utf8').trim();
  const hostContract = '读取 /melina/artifacts/BENCHMARK_INSTANCE.json 和 /melina/artifacts/BENCHMARK_PROGRESS.json';
  let deps: InfraDeps | undefined;
  let assembler: ContextAssembler | undefined;
  let runtime: RuntimeKernel | undefined;
  const app = new Melina(
    { db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts') },
    {
      containers: null,
      env: {},
      log: { warn() {}, error() {} },
      runtime: melinaRuntime({
        onCreated(value) {
          runtime = value;
        },
        extensions: [
          ctfExtension,
          (value) => {
            deps = value;
            return {
              tools: [],
              prepare(services) {
                assembler = services.assembler;
              },
            };
          },
        ],
      }),
    },
  );
  try {
    await app.ready();
    if (!deps || !assembler || !runtime) throw new Error('运行时没有完成组装');
    await runtime.runs.stop();
    for (const domain of ['general', 'ctf', undefined, 'ctf'] as const) {
      for (const statement of domain === 'ctf'
        ? [
            '核对授权目标',
            `核对授权目标\n${policy}`,
            '# CTF 执行约束\n旧版正文',
            hostContract,
            `${hostContract}\n${policy}\n${tsecPolicy}`,
            `${hostContract}\n# TSec 宿主协议\n旧版正文`,
            '状态入口在完成标准中',
          ]
        : ['核对授权目标', hostContract]) {
        const hosted = statement.includes(hostContract) || statement === '状态入口在完成标准中';
        const run = deps.writer.createRun({
          id: newId(),
          goal: {
            statement,
            domain,
            constraints: [],
            materials: [],
            ...(statement === '状态入口在完成标准中'
              ? { completion: { interpretation: hostContract, criteria: ['平台确认剩余目标为零'] } }
              : {}),
          },
          workspace: { root: dir, kind: 'dir-copy' },
          config: {
            ...DEFAULT_RUN_CONFIG,
            bet0: { models: [{ provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' }] },
          },
          createdAt: '2026-10-18T00:00:00.000Z',
        });
        const bet = deps.writer.createBet({
          kind: 'direct',
          label: '解题路线',
          model: { provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' },
          startFrom: { snapshot: 'root' },
          runId: run.id,
          source: { kind: 'template' },
        });
        const branch = deps.writer.createBranch({ runId: run.id, betId: bet.id, lastSnapshot: 'root' });
        if (statement === '核对授权目标') {
          deps.writer.updateBranch(branch.id, { state: 'running', queued: false, workspace: { path: dir } });
          const versions = ['阶段一', '阶段二'].map((claim) => {
            const snapshot = `snap-${newId()}`;
            return {
              candidateId: deps!.writer.deliverVersion({
                branchId: branch.id,
                episode: branch.episode,
                snapshot: { id: snapshot },
                candidate: { runId: run.id, branchId: branch.id, snapshot, claim, interim: true },
              }).candidate.id,
              patch: '',
            };
          });
          for (const layout of [assembler.forScoper(run), assembler.forSelection(run.id, { versions })]) {
            expect(JSON.stringify(layout)).not.toContain('REBUILD_REQUEST.json');
            expect(JSON.stringify(layout)).not.toContain('filtered_local_candidates');
          }
        }
        for (const layout of [
          assembler.forExplorer(branch),
          assembler.forWatcher(run.id, { branchId: branch.id, untilSeq: deps.queries.lastSeq() }),
        ]) {
          expect(layout.system.includes(policy)).toBe(domain === 'ctf');
          expect(layout.system.split(policy)).toHaveLength(domain === 'ctf' ? 2 : 1);
          expect(layout.system.split(tsecPolicy)).toHaveLength(domain === 'ctf' && hosted ? 2 : 1);
          expect(layout.system.includes('REBUILD_REQUEST.json')).toBe(domain === 'ctf' && hosted);
          expect(layout.system.includes('filtered_local_candidates')).toBe(domain === 'ctf' && hosted);
        }
      }
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
