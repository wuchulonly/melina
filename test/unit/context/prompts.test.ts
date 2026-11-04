import { expect, it } from 'vitest';
import { loadPrompt, loadSharedPrompt, type PromptName } from '../../../src/context/prompts.ts';
import { secretsIn } from '../../../src/tools/secret-scan.ts';

it('当前角色提示完整，无已删除协议或凭证泄漏', () => {
  for (const role of ['explorer', 'scoper', 'selection', 'watcher'] satisfies PromptName[]) {
    const prompt = loadPrompt(role);
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).not.toMatch(/record_fact|record_surprise|board_query|submit_decision/);
    expect(secretsIn(prompt, `${role}.md`)).toEqual([]);
    expect(prompt.split(loadSharedPrompt('sources'))).toHaveLength(2);
  }
});
it('直接会话说明长会话、自动压缩和文字交接', () => {
  const prompt = loadPrompt('explorer');
  expect(prompt).toContain('自动压缩');
  expect(prompt).toContain('handoff');
  expect(prompt).toContain('candidate');
  expect(prompt).not.toContain('Notebook');
});
