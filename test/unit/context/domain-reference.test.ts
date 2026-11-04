import { describe, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { newId } from '../../../src/core/ids.ts';
import type { RunStore } from '../../../src/storage/state.ts';
import { newRun, startBranch, testRunStore } from '../storage/kit.ts';

const domains = [
  { name: 'ctf', description: '环境参考 /melina/ctf/README.md。' },
  { name: 'code', description: '代码领域的独立环境入口' },
];

function pendingRunWithDomain(runStore: RunStore, domain: string) {
  const seed = newRun(runStore, { completion: false });
  return runStore.writer.createRun({
    id: newId(),
    goal: { ...seed.goal, domain },
    workspace: seed.workspace,
    config: seed.config,
    createdAt: seed.createdAt,
  });
}

describe('Explorer 当前领域的参考入口', () => {
  it('Bet0 不等 Scoper，建任务给定领域时就能看到该领域的入口', () => {
    const runStore = testRunStore();
    const run = pendingRunWithDomain(runStore, 'ctf');
    const { branch } = startBranch(runStore, run, { kind: 'direct' });
    const assembler = new MelinaContextAssembler({ queries: runStore.queries, domains: () => domains });
    const first = assembler.forExplorer(branch);

    expect(first.system).toContain(domains[0]?.description);
    expect(first.system).not.toContain(domains[1]?.description);
    expect(first.system).toContain('还在起草');
    expect(assembler.forExplorer({ ...branch, episode: branch.episode + 1 }).system).toBe(first.system);
    expect(first.tools.some((tool) => tool.name === 'read')).toBe(true);
    expect(first.tools.some((tool) => tool.name === 'credential')).toBe(false);
  });

  it('其他领域的分支只得到自己的说明', () => {
    const runStore = testRunStore();
    const run = newRun(runStore);
    const { branch } = startBranch(runStore, run, { kind: 'direct' });
    const layout = new MelinaContextAssembler({ queries: runStore.queries, domains: () => domains }).forExplorer(
      branch,
    );

    expect(layout.system).toContain(domains[1]?.description);
    expect(layout.system).not.toContain('/melina/ctf/');
  });

  it('未指定领域或没有可用说明时不猜测参考路径', () => {
    const runStore = testRunStore();
    const run = newRun(runStore, { completion: false });
    const { branch } = startBranch(runStore, run, { kind: 'direct' });
    const assembler = new MelinaContextAssembler({ queries: runStore.queries, domains: () => domains });

    expect(assembler.forExplorer(branch).system).not.toContain('领域说明：');
    const unknown = pendingRunWithDomain(runStore, 'unavailable');
    const { branch: unknownBranch } = startBranch(runStore, unknown, { kind: 'direct' });
    expect(assembler.forExplorer(unknownBranch).system).not.toContain('领域说明：');
    const withoutDomains = new MelinaContextAssembler({ queries: runStore.queries });
    const known = pendingRunWithDomain(runStore, 'ctf');
    const { branch: knownBranch } = startBranch(runStore, known, { kind: 'direct' });
    expect(withoutDomains.forExplorer(knownBranch).system).not.toContain('领域说明：');
  });
});
